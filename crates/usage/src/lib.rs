//! hive-usage — the Usage panel's data: tokens and estimated cost from every
//! coding-agent CLI's own history on this machine (Claude Code's and Codex's
//! transcripts, OpenCode's database), so work done outside Hive counts too.
//! Modelled on t3code's usage page.
//!
//! What's been read is cached as `usage/scan.json` in the data dir: files
//! that didn't change aren't read again, grown ones are read on from where
//! they stopped, and the usage of deleted transcripts (Claude prunes old
//! ones) stays for [`KEEP_MS`]. Prices: [`pricing`].

mod aggregate;
mod claude;
mod codex;
mod files;
mod opencode;
pub mod pricing;
mod record;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use hive_proto::{
    HarnessId, UsagePricing, UsagePricingStatus, UsageQuery, UsageReport, UsageSource,
    UsageSourceStatus,
};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use aggregate::{Aggregator, View};
use claude::Claude;
use codex::Codex;
use files::FileEntry;
use pricing::RateTable;
use record::NONE;

/// Usage older than this is dropped from the cache (the longest range is 90 days).
pub const KEEP_MS: i64 = 92 * 86_400_000;
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

    async fn refresh_prices(&self, state: &mut State, force: bool) -> UsagePricing {
        let path = self.dir.join("prices.json");
        if state.prices.is_none() {
            let table = tokio::task::spawn_blocking({
                let path = path.clone();
                move || pricing::load(&path)
            })
            .await
            .unwrap_or_default();
            state.prices = Some(table);
        }
        let now = now_ms();
        let fetched = state.prices.as_ref().and_then(|t| t.fetched_at);
        let stale = fetched.map_or(true, |t| now - t > pricing::MAX_AGE_MS);
        let forced = force && now - state.price_forced >= PRICE_FORCE_MS;
        if forced || (stale && now - state.price_attempt >= PRICE_RETRY_MS) {
            state.price_attempt = now;
            if forced {
                state.price_forced = now;
            }
            match pricing::fetch(now).await {
                Ok(table) => {
                    let saved = table.clone();
                    let _ = tokio::task::spawn_blocking(move || pricing::save(&path, &saved)).await;
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
    let since = query.buckets[0];
    let skip_before = since - FILE_SLACK_MS;
    let mut sources = Vec::new();

    let claude_roots = claude::roots();
    let claude = files::scan(&claude_roots, &mut cache.claude, skip_before);
    sources.push(file_source(HarnessId::ClaudeCode, &claude_roots, &claude));
    let codex_roots = codex::roots();
    let codex = files::scan(&codex_roots, &mut cache.codex, skip_before);
    sources.push(file_source(HarnessId::Codex, &codex_roots, &codex));
    let before = opencode_signature(cache);
    let oc = opencode::scan(&mut cache.opencode, since);
    let oc_changed = opencode_signature(cache) != before;
    sources.push(UsageSource {
        harness: HarnessId::Opencode,
        status: status(oc.found, oc.files, u32::from(oc.error.is_some())),
        path: opencode::data_dir().map(|d| d.to_string_lossy().into_owned()),
        files: oc.files,
        error: oc.error,
    });

    let pruned = prune(cache, now);
    if claude.changed || codex.changed || oc_changed || pruned || cache.version != CACHE_VERSION {
        cache.version = CACHE_VERSION;
        save_cache(dir, cache);
    }

    let mut agg = Aggregator::new(query, prices);
    // Sorted, so which copy of a request counts doesn't depend on hashing.
    let mut paths: Vec<&String> = cache.claude.keys().collect();
    paths.sort();
    for path in paths {
        add_file(&mut agg, HarnessId::ClaudeCode, path, &cache.claude[path]);
    }
    for (path, entry) in &cache.codex {
        add_file(&mut agg, HarnessId::Codex, path, entry);
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

fn add_file<S>(agg: &mut Aggregator<'_>, harness: HarnessId, path: &str, entry: &FileEntry<S>) {
    let r = &entry.records;
    for rec in &r.records {
        if rec.at < agg.since() {
            continue;
        }
        let text = |i: u32| if i == NONE { None } else { r.string(i) };
        agg.add(
            View {
                harness,
                at: rec.at,
                model: text(rec.model).unwrap_or(""),
                session: text(rec.session).unwrap_or(""),
                project: text(rec.project),
                counts: &rec.counts,
                cost: rec.cost,
                fast: rec.fast,
                key: rec.key,
            },
            path,
        );
    }
}

fn file_source(harness: HarnessId, roots: &[PathBuf], stats: &files::ScanStats) -> UsageSource {
    UsageSource {
        harness,
        status: status(stats.found, stats.files, stats.failed),
        path: roots.first().map(|r| r.to_string_lossy().into_owned()),
        files: stats.files,
        error: stats.error.clone(),
    }
}

fn status(found: bool, read: u32, failed: u32) -> UsageSourceStatus {
    match (found, read, failed) {
        (false, _, _) => UsageSourceStatus::Missing,
        (true, _, 0) => UsageSourceStatus::Ok,
        (true, 0, _) => UsageSourceStatus::Failed,
        (true, _, _) => UsageSourceStatus::Partial,
    }
}

fn opencode_signature(cache: &Cache) -> (usize, i64, i64) {
    cache.opencode.values().fold((0, 0, 0), |(n, through, from), db| {
        (n + db.messages.len(), through.max(db.through), from.min(db.from))
    })
}

/// Drops usage older than [`KEEP_MS`]; true when anything went.
fn prune(cache: &mut Cache, now: i64) -> bool {
    let cutoff = now - KEEP_MS;
    let before = cache.claude.len() + cache.codex.len();
    cache.claude.retain(|_, e| e.newest() >= cutoff);
    cache.codex.retain(|_, e| e.newest() >= cutoff);
    let mut changed = before != cache.claude.len() + cache.codex.len();
    for db in cache.opencode.values_mut() {
        let n = db.messages.len();
        db.messages.retain(|_, m| m.at >= cutoff);
        changed |= n != db.messages.len();
    }
    changed
}

fn load_cache(dir: &Path) -> Cache {
    std::fs::read(dir.join("scan.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Cache>(&bytes).ok())
        .filter(|c| c.version == CACHE_VERSION)
        .unwrap_or_default()
}

fn save_cache(dir: &Path, cache: &Cache) {
    match serde_json::to_vec(cache) {
        Ok(bytes) => write_atomic(&dir.join("scan.json"), &bytes),
        Err(e) => eprintln!("hive-usage: couldn't save the scan: {e}"),
    }
}

/// Through a temp file renamed over the target.
pub(crate) fn write_atomic(path: &Path, bytes: &[u8]) {
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
