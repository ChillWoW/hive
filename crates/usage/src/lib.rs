//! hive-usage — the Usage panel's data: tokens and estimated cost from every
//! coding-agent CLI's own history on this machine (Claude Code's and Codex's
//! transcripts, OpenCode's database, Pi's sessions), so work done outside
//! Hive counts too.
//!
//! What's been read is cached as `usage/scan.json` in the data dir: files
//! that didn't change aren't read again, grown ones are read on from where
//! they stopped, and the usage of deleted transcripts (Claude prunes old
//! ones) stays for `KEEP_MS`. Prices: `pricing.rs`.

mod aggregate;
mod claude;
mod codex;
mod files;
mod opencode;
mod pi;
mod pricing;
mod record;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use hive_proto::{
    HarnessId, SessionUsage, UsagePricing, UsagePricingStatus, UsageQuery, UsageReport, UsageRow,
    UsageSource, UsageSourceStatus,
};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use aggregate::{Aggregator, View};
use claude::Claude;
use codex::Codex;
use files::{FileEntry, ScanStats};
use pi::Pi;
use pricing::RateTable;

/// Usage older than this is dropped from the cache (the longest range is 90 days).
const KEEP_MS: i64 = 92 * 86_400_000;
/// Files last written this long before a range starts can't hold any of it.
const FILE_SLACK_MS: i64 = 36 * 3_600_000;
/// Between failed price fetches, unless asked.
const PRICE_RETRY_MS: i64 = 10 * 60_000;
/// Between fetches the Refresh button asks for.
const PRICE_FORCE_MS: i64 = 60_000;
/// Bump when the cached shapes or parsers change: the cache starts over.
const CACHE_VERSION: u32 = 1;

#[derive(Default, Serialize, Deserialize)]
struct Cache {
    version: u32,
    claude: HashMap<String, FileEntry<Claude>>,
    codex: HashMap<String, FileEntry<Codex>>,
    opencode: HashMap<String, opencode::Database>,
    #[serde(default)]
    pi: HashMap<String, FileEntry<Pi>>,
}

#[derive(Default)]
struct State {
    cache: Option<Cache>,
    prices: Option<RateTable>,
    price_attempt: i64,
    price_forced: i64,
    price_fresh: bool,
}

pub struct Usage {
    dir: PathBuf,
    state: Mutex<State>,
}

impl Usage {
    /// `data_dir`: the app's; everything goes under `usage/` in it.
    pub fn new(data_dir: &Path) -> Self {
        Self { dir: data_dir.join("usage"), state: Mutex::new(State::default()) }
    }

    /// Reads whatever changed and sums the range. One at a time: a second
    /// caller waits and then finds the cache warm.
    pub async fn report(&self, query: UsageQuery) -> Result<UsageReport, String> {
        if query.buckets.is_empty() || query.until <= query.buckets[0] {
            return Err("An empty range".into());
        }
        let mut state = self.state.lock().await;
        let pricing = self.refresh_prices(&mut state, query.refresh_prices).await;
        let prices = state.prices.clone().unwrap_or_default();
        let cache = state.cache.take();
        let dir = self.dir.clone();
        let (cache, report) = tokio::task::spawn_blocking(move || {
            let mut cache = cache.unwrap_or_else(|| load_cache(&dir));
            let report = build(&mut cache, &prices, &query, pricing, &dir);
            (cache, report)
        })
        .await
        .map_err(|e| format!("The scan failed: {e}"))?;
        state.cache = Some(cache);
        Ok(report)
    }

    /// `harness`'s session `id` (a chat's `harness_session_id`) over all the
    /// history the cache keeps, read and priced as `report` does.
    pub async fn session(&self, harness: HarnessId, id: String) -> Result<SessionUsage, String> {
        let mut state = self.state.lock().await;
        self.refresh_prices(&mut state, false).await;
        let prices = state.prices.clone().unwrap_or_default();
        let cache = state.cache.take();
        let dir = self.dir.clone();
        let (cache, usage) = tokio::task::spawn_blocking(move || {
            let mut cache = cache.unwrap_or_else(|| load_cache(&dir));
            let now = now_ms();
            let since = now - KEEP_MS;
            scan(&mut cache, since, now, &dir);
            // Past `now`: a request written while this runs still counts.
            let query = UsageQuery { buckets: vec![since], until: now + 60_000, refresh_prices: false };
            let mut agg = Aggregator::new(&query, &prices).only_session(harness, &id);
            aggregate(&cache, &mut agg);
            let usage = session_usage(agg.finish().0);
            (cache, usage)
        })
        .await
        .map_err(|e| format!("The scan failed: {e}"))?;
        state.cache = Some(cache);
        Ok(usage)
    }

    async fn refresh_prices(&self, state: &mut State, force: bool) -> UsagePricing {
        let path = self.dir.join("prices.json");
        if state.prices.is_none() {
            let table = tokio::task::spawn_blocking({
                let path = path.clone();
                move || read_json(&path)
            })
            .await
            .ok()
            .flatten()
            .unwrap_or_default();
            state.prices = Some(table);
        }
        let now = now_ms();
        let fetched = state.prices.as_ref().and_then(|t| t.fetched_at);
        let stale = fetched.is_none_or(|t| now - t > pricing::MAX_AGE_MS);
        let forced = force && now - state.price_forced >= PRICE_FORCE_MS;
        if forced || (stale && now - state.price_attempt >= PRICE_RETRY_MS) {
            state.price_attempt = now;
            if forced {
                state.price_forced = now;
            }
            match pricing::fetch(now).await {
                Ok(table) => {
                    let saved = table.clone();
                    let _ = tokio::task::spawn_blocking(move || write_json(&path, &saved)).await;
                    state.prices = Some(table);
                    state.price_fresh = true;
                }
                Err(e) => eprintln!("hive-usage: {e}"),
            }
        }
        let table = state.prices.as_ref().expect("loaded above");
        let status = if table.models.is_empty() {
            UsagePricingStatus::Unavailable
        } else if state.price_fresh
            && table.fetched_at.is_some_and(|t| now - t <= pricing::MAX_AGE_MS)
        {
            UsagePricingStatus::Fresh
        } else {
            UsagePricingStatus::Cached
        };
        UsagePricing {
            status,
            fetched_at: table.fetched_at,
            models: table.models.len() as u32,
        }
    }
}

fn build(
    cache: &mut Cache,
    prices: &RateTable,
    query: &UsageQuery,
    pricing: UsagePricing,
    dir: &Path,
) -> UsageReport {
    let started = Instant::now();
    let now = now_ms();
    let sources = scan(cache, query.buckets[0], now, dir);
    let mut agg = Aggregator::new(query, prices);
    aggregate(cache, &mut agg);
    let (rows, models, harnesses, projects, sessions) = agg.finish();
    UsageReport {
        rows,
        models,
        harnesses,
        projects,
        sessions,
        sources,
        pricing,
        read_at: now,
        scan_ms: started.elapsed().as_millis().min(u128::from(u32::MAX)) as u32,
    }
}

/// Reads whatever changed since `since` into the cache (saving it when it
/// changed); where each harness's history was read from.
fn scan(cache: &mut Cache, since: i64, now: i64, dir: &Path) -> Vec<UsageSource> {
    let skip_before = since - FILE_SLACK_MS;
    let claude_roots = claude::roots();
    let claude = files::scan(&claude_roots, &mut cache.claude, skip_before);
    let codex_roots = codex::roots();
    let codex = files::scan(&codex_roots, &mut cache.codex, skip_before);
    let oc_dir = opencode::data_dir();
    let oc = opencode::scan(oc_dir.as_deref(), &mut cache.opencode, since);
    let pi_roots = pi::roots();
    let pi = files::scan(&pi_roots, &mut cache.pi, skip_before);
    let sources = vec![
        source(HarnessId::ClaudeCode, claude_roots.first(), &claude),
        source(HarnessId::Codex, codex_roots.first(), &codex),
        source(HarnessId::Opencode, oc_dir.as_ref(), &oc),
        source(HarnessId::Pi, pi_roots.first(), &pi),
    ];

    let pruned = prune(cache, now);
    if claude.changed || codex.changed || oc.changed || pi.changed || pruned || cache.version != CACHE_VERSION {
        cache.version = CACHE_VERSION;
        write_json(&dir.join("scan.json"), cache);
    }
    sources
}

/// Every cached record into `agg`.
fn aggregate(cache: &Cache, agg: &mut Aggregator<'_>) {
    // Sorted, so which copy of a request counts doesn't depend on hashing.
    let mut paths: Vec<&String> = cache.claude.keys().collect();
    paths.sort();
    for path in paths {
        add_file(agg, HarnessId::ClaudeCode, path, &cache.claude[path]);
    }
    for (path, entry) in &cache.codex {
        add_file(agg, HarnessId::Codex, path, entry);
    }
    let mut paths: Vec<&String> = cache.pi.keys().collect();
    paths.sort();
    for path in paths {
        add_file(agg, HarnessId::Pi, path, &cache.pi[path]);
    }
    for db in cache.opencode.values() {
        for (id, m) in &db.messages {
            agg.add(
                View {
                    harness: HarnessId::Opencode,
                    at: m.at,
                    model: &m.model,
                    session: &m.session,
                    project: m.project.as_deref(),
                    counts: &m.counts,
                    cost: m.cost,
                    fast: false,
                    key: 0,
                },
                id,
            );
        }
    }
}

/// One session's rows summed; its models by tokens, most first.
fn session_usage(rows: Vec<UsageRow>) -> SessionUsage {
    let mut usage = SessionUsage::default();
    let mut models: Vec<(String, u64)> = Vec::new();
    for row in rows {
        usage.tokens.add(&row.tokens);
        usage.cost.add(&row.cost);
        usage.requests += row.requests;
        usage.unpriced += row.unpriced;
        match models.iter_mut().find(|(m, _)| *m == row.model) {
            Some((_, tokens)) => *tokens += row.tokens.total(),
            None => models.push((row.model, row.tokens.total())),
        }
    }
    models.sort_by_key(|(_, tokens)| std::cmp::Reverse(*tokens));
    usage.models = models.into_iter().map(|(m, _)| m).filter(|m| !m.is_empty()).collect();
    usage
}

fn add_file<S>(agg: &mut Aggregator<'_>, harness: HarnessId, path: &str, entry: &FileEntry<S>) {
    let r = &entry.records;
    for rec in &r.records {
        if rec.at < agg.since() {
            continue;
        }
        // `NONE` is past the end of the table.
        agg.add(
            View {
                harness,
                at: rec.at,
                model: r.string(rec.model).unwrap_or(""),
                session: r.string(rec.session).unwrap_or(""),
                project: r.string(rec.project),
                counts: &rec.counts,
                cost: rec.cost,
                fast: rec.fast,
                key: rec.key,
            },
            path,
        );
    }
}

/// `path`: the folder the harness's history is read from.
fn source(harness: HarnessId, path: Option<&PathBuf>, stats: &ScanStats) -> UsageSource {
    UsageSource {
        harness,
        status: match (stats.found, stats.files, stats.failed) {
            (false, _, _) => UsageSourceStatus::Missing,
            (true, _, 0) => UsageSourceStatus::Ok,
            (true, 0, _) => UsageSourceStatus::Failed,
            (true, _, _) => UsageSourceStatus::Partial,
        },
        path: path.map(|p| p.to_string_lossy().into_owned()),
        files: stats.files,
        error: stats.error.clone(),
    }
}

/// Drops usage older than [`KEEP_MS`]; true when anything went.
fn prune(cache: &mut Cache, now: i64) -> bool {
    let cutoff = now - KEEP_MS;
    let before = cache.claude.len() + cache.codex.len() + cache.pi.len();
    cache.claude.retain(|_, e| e.newest() >= cutoff);
    cache.codex.retain(|_, e| e.newest() >= cutoff);
    cache.pi.retain(|_, e| e.newest() >= cutoff);
    let mut changed = before != cache.claude.len() + cache.codex.len() + cache.pi.len();
    for db in cache.opencode.values_mut() {
        let n = db.messages.len();
        db.messages.retain(|_, m| m.at >= cutoff);
        changed |= n != db.messages.len();
    }
    changed
}

fn load_cache(dir: &Path) -> Cache {
    read_json::<Cache>(&dir.join("scan.json"))
        .filter(|c| c.version == CACHE_VERSION)
        .unwrap_or_default()
}

fn read_json<T: DeserializeOwned>(path: &Path) -> Option<T> {
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

/// Through a temp file renamed over the target.
fn write_json<T: Serialize>(path: &Path, value: &T) {
    let bytes = match serde_json::to_vec(value) {
        Ok(bytes) => bytes,
        Err(e) => return eprintln!("hive-usage: couldn't save {}: {e}", path.display()),
    };
    let Some(dir) = path.parent() else { return };
    if std::fs::create_dir_all(dir).is_err() {
        return;
    }
    let tmp = path.with_extension("tmp");
    if std::fs::write(&tmp, bytes).is_ok() && std::fs::rename(&tmp, path).is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
}

pub(crate) fn home() -> Option<PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from)
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
}
