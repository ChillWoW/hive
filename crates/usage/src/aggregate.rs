//! Records → a [`UsageReport`]: priced, deduplicated across files, summed
//! per (bucket, harness, model), with session counts per model, harness and
//! project over the whole range.

use std::collections::{HashMap, HashSet};

use hive_proto::{
    HarnessId, UsageCost, UsageHarness, UsageModel, UsageProject, UsageProjectHarness, UsageQuery,
    UsageRow, UsageTokens,
};

use crate::pricing::{ModelRate, RateTable};
use crate::record::{fnv, Counts, CACHE_READ, CACHE_WRITE, INPUT, OUTPUT, REASONING};

/// Projects listed at most.
const MAX_PROJECTS: usize = 40;

pub struct View<'a> {
    pub harness: HarnessId,
    pub at: i64,
    pub model: &'a str,
    /// Empty when unknown (the file then stands for the session).
    pub session: &'a str,
    pub project: Option<&'a str>,
    pub counts: &'a Counts,
    pub cost: Option<f64>,
    pub fast: bool,
    pub key: u64,
}

#[derive(Default)]
struct ProjectHarness {
    tokens: u64,
    cost: f64,
    requests: u32,
    sessions: HashSet<u64>,
}

type Project = HashMap<HarnessId, ProjectHarness>;

pub struct Aggregator<'a> {
    query: &'a UsageQuery,
    prices: &'a RateTable,
    models: HashMap<String, u32>,
    model_names: Vec<String>,
    rates: Vec<Option<ModelRate>>,
    seen: HashSet<u64>,
    rows: HashMap<(u32, HarnessId, u32), UsageRow>,
    model_sessions: HashMap<(HarnessId, u32), HashSet<u64>>,
    harness_sessions: HashMap<HarnessId, HashSet<u64>>,
    sessions: HashSet<u64>,
    projects: HashMap<String, Project>,
}

fn harness_tag(h: HarnessId) -> u8 {
    match h {
        HarnessId::ClaudeCode => 1,
        HarnessId::Codex => 2,
        HarnessId::Opencode => 3,
        HarnessId::Mock => 4,
    }
}

impl<'a> Aggregator<'a> {
    pub fn new(query: &'a UsageQuery, prices: &'a RateTable) -> Self {
        Self {
            query,
            prices,
            models: HashMap::new(),
            model_names: Vec::new(),
            rates: Vec::new(),
            seen: HashSet::new(),
            rows: HashMap::new(),
            model_sessions: HashMap::new(),
            harness_sessions: HashMap::new(),
            sessions: HashSet::new(),
            projects: HashMap::new(),
        }
    }

    pub fn since(&self) -> i64 {
        self.query.buckets.first().copied().unwrap_or(i64::MAX)
    }

    fn model(&mut self, name: &str) -> u32 {
        if let Some(&id) = self.models.get(name) {
            return id;
        }
        let id = self.model_names.len() as u32;
        self.models.insert(name.to_owned(), id);
        self.model_names.push(name.to_owned());
        self.rates.push(self.prices.lookup(name).copied());
        id
    }

    /// `fallback_session` names the session when the record doesn't.
    pub fn add(&mut self, r: View<'_>, fallback_session: &str) {
        if r.at < self.since() || r.at >= self.query.until {
            return;
        }
        // The same request copied into another file (resumed, forked).
        if r.key != 0 && !self.seen.insert(r.key) {
            return;
        }
        let bucket = self.query.buckets.partition_point(|&b| b <= r.at).saturating_sub(1) as u32;
        let model = self.model(r.model);
        let session = {
            let name = if r.session.is_empty() { fallback_session } else { r.session };
            fnv(name.as_bytes()) ^ u64::from(harness_tag(r.harness)) << 56
        };

        let tokens = UsageTokens {
            input: r.counts[INPUT],
            cache_read: r.counts[CACHE_READ],
            cache_write: r.counts[CACHE_WRITE],
            output: r.counts[OUTPUT],
            reasoning: r.counts[REASONING],
        };
        let (cost, priced) = cost(self.rates[model as usize].as_ref(), r.counts, r.fast, r.cost);

        let row = self.rows.entry((bucket, r.harness, model)).or_insert_with(|| UsageRow {
            bucket,
            harness: r.harness,
            model: self.model_names[model as usize].clone(),
            tokens: UsageTokens::default(),
            cost: UsageCost::default(),
            requests: 0,
            unpriced: 0,
        });
        row.tokens.add(&tokens);
        row.cost.add(&cost);
        row.requests += 1;
        if !priced {
            row.unpriced += 1;
        }

        self.model_sessions.entry((r.harness, model)).or_default().insert(session);
        self.harness_sessions.entry(r.harness).or_default().insert(session);
        self.sessions.insert(session);
        if let Some(path) = r.project.filter(|p| !p.is_empty()) {
            if !self.projects.contains_key(path) {
                self.projects.insert(path.to_owned(), Project::default());
            }
            let project = self.projects.get_mut(path).expect("just inserted");
            let p = project.entry(r.harness).or_default();
            p.tokens += tokens.total();
            p.cost += cost.total();
            p.requests += 1;
            p.sessions.insert(session);
        }
    }

    pub fn finish(
        self,
    ) -> (Vec<UsageRow>, Vec<UsageModel>, Vec<UsageHarness>, Vec<UsageProject>, u32) {
        let mut rows: Vec<UsageRow> = self.rows.into_values().collect();
        rows.sort_by(|a, b| {
            (a.bucket, harness_tag(a.harness), &a.model).cmp(&(b.bucket, harness_tag(b.harness), &b.model))
        });
        let mut models: Vec<UsageModel> = self
            .model_sessions
            .into_iter()
            .map(|((harness, model), s)| UsageModel {
                harness,
                model: self.model_names[model as usize].clone(),
                sessions: s.len() as u32,
            })
            .collect();
        models.sort_by(|a, b| (harness_tag(a.harness), &a.model).cmp(&(harness_tag(b.harness), &b.model)));
        let mut harnesses: Vec<UsageHarness> = self
            .harness_sessions
            .into_iter()
            .map(|(harness, s)| UsageHarness { harness, sessions: s.len() as u32 })
            .collect();
        harnesses.sort_by_key(|h| harness_tag(h.harness));
        let mut projects: Vec<(f64, u64, UsageProject)> = self
            .projects
            .into_iter()
            .map(|(path, p)| {
                let mut harnesses: Vec<UsageProjectHarness> = p
                    .into_iter()
                    .map(|(harness, p)| UsageProjectHarness {
                        harness,
                        tokens: p.tokens,
                        cost: p.cost,
                        sessions: p.sessions.len() as u32,
                        requests: p.requests,
                    })
                    .collect();
                harnesses.sort_by(|a, b| b.tokens.cmp(&a.tokens));
                let cost = harnesses.iter().map(|h| h.cost).sum();
                let tokens = harnesses.iter().map(|h| h.tokens).sum();
                (cost, tokens, UsageProject { path, harnesses })
            })
            .collect();
        projects.sort_by(|a, b| b.0.total_cmp(&a.0).then(b.1.cmp(&a.1)));
        projects.truncate(MAX_PROJECTS);
        let projects = projects.into_iter().map(|(_, _, p)| p).collect();
        (rows, models, harnesses, projects, self.sessions.len() as u32)
    }
}

/// A request's cost and whether it has one. A reported cost wins over the
/// table's, split in the table's proportions when the model is known.
fn cost(rate: Option<&ModelRate>, counts: &Counts, fast: bool, reported: Option<f64>) -> (UsageCost, bool) {
    let priced = rate.map(|r| r.price(counts, fast));
    match (priced, reported) {
        (Some(p), reported) if reported.is_none() || p.total() > 0.0 => {
            let scale = match reported {
                Some(r) => r / p.total(),
                None => 1.0,
            };
            (
                UsageCost {
                    input: p.input * scale,
                    cache_read: p.cache_read * scale,
                    cache_write: p.cache_write * scale,
                    output: p.output * scale,
                    other: 0.0,
                    savings: p.savings,
                    fast_premium: p.fast_premium * scale,
                },
                true,
            )
        }
        (_, Some(r)) => (UsageCost { other: r, ..UsageCost::default() }, true),
        (_, None) => (UsageCost::default(), false),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn buckets_dedups_and_prices() {
        let prices = RateTable::parse(
            &json!({ "m1": { "input_cost_per_token": 1.0, "output_cost_per_token": 2.0 } }),
            0,
        );
        let query = UsageQuery { buckets: vec![0, 100, 200], until: 300, refresh_prices: false };
        let mut agg = Aggregator::new(&query, &prices);
        let counts: Counts = [1, 0, 0, 1, 0, 0];
        let view = |at, model, key, cost| View {
            harness: HarnessId::ClaudeCode,
            at,
            model,
            session: "s",
            project: Some("/p"),
            counts: &counts,
            cost,
            fast: false,
            key,
        };
        agg.add(view(5, "m1", 1, None), "");
        agg.add(view(6, "m1", 1, None), ""); // copy
        agg.add(view(150, "m1", 2, Some(6.0)), ""); // reported: 3 at list → scaled ×2
        agg.add(view(250, "m2", 3, None), ""); // unpriced
        agg.add(view(300, "m1", 4, None), ""); // out of range
        let (rows, models, harnesses, projects, sessions) = agg.finish();
        assert_eq!(rows.len(), 3);
        assert_eq!((rows[0].bucket, rows[0].requests, rows[0].cost.total()), (0, 1, 3.0));
        assert_eq!((rows[1].bucket, rows[1].cost.input, rows[1].cost.output), (1, 2.0, 4.0));
        assert_eq!((rows[2].bucket, rows[2].unpriced, rows[2].tokens.total()), (2, 1, 2));
        assert_eq!(models.len(), 2);
        assert_eq!(harnesses[0].sessions, 1);
        assert_eq!(sessions, 1);
        assert_eq!(projects[0].harnesses[0].requests, 3);
        assert_eq!(projects[0].harnesses[0].cost, 9.0);
        assert_eq!(projects[0].harnesses[0].sessions, 1);
    }
}
