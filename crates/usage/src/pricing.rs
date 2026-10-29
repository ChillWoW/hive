//! Per-token prices from LiteLLM's public table
//! (`model_prices_and_context_window.json`, as t3code uses), kept as
//! `usage/prices.json` in the data dir and fetched again once a day. A model
//! it doesn't know stays unpriced (counted, never charged $0).

use std::collections::HashMap;
use std::path::Path;
use std::sync::OnceLock;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::record::{Counts, CACHE_READ, CACHE_WRITE, CACHE_WRITE_1H, INPUT, OUTPUT};

const URL: &str =
    "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const TIMEOUT: Duration = Duration::from_secs(20);
pub const MAX_AGE_MS: i64 = 24 * 3_600_000;

/// USD per token.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Rates {
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
    pub cache_write: f64,
    /// Cache writes held for an hour (Anthropic).
    pub cache_write_1h: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct ModelRate {
    pub standard: Rates,
    /// Fast mode / priority tier.
    pub fast: Option<Rates>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RateTable {
    pub fetched_at: Option<i64>,
    pub models: HashMap<String, ModelRate>,
}

/// A request's cost by token type; `fast_premium` is part of the sum.
#[derive(Debug, Clone, Copy, Default)]
pub struct Priced {
    pub input: f64,
    pub cache_read: f64,
    pub cache_write: f64,
    pub output: f64,
    pub savings: f64,
    pub fast_premium: f64,
}

impl Priced {
    pub fn total(&self) -> f64 {
        self.input + self.cache_read + self.cache_write + self.output
    }
}

impl Rates {
    fn price(&self, counts: &Counts) -> Priced {
        let hour = counts[CACHE_WRITE_1H].min(counts[CACHE_WRITE]);
        Priced {
            input: counts[INPUT] as f64 * self.input,
            cache_read: counts[CACHE_READ] as f64 * self.cache_read,
            cache_write: (counts[CACHE_WRITE] - hour) as f64 * self.cache_write
                + hour as f64 * self.cache_write_1h,
            output: counts[OUTPUT] as f64 * self.output,
            savings: counts[CACHE_READ] as f64 * (self.input - self.cache_read).max(0.0),
            fast_premium: 0.0,
        }
    }
}

impl ModelRate {
    pub fn price(&self, counts: &Counts, fast: bool) -> Priced {
        let standard = self.standard.price(counts);
        match (fast, self.fast) {
            (true, Some(fast)) => {
                let mut priced = fast.price(counts);
                priced.fast_premium = (priced.total() - standard.total()).max(0.0);
                priced
            }
            _ => standard,
        }
    }
}

/// Bare family names say nothing about the generation; synthetic messages
/// are never billed.
const UNPRICEABLE: &[&str] = &["<synthetic>", "synthetic", "opus", "sonnet", "haiku", "fable"];

impl RateTable {
    /// The rate for a model as a history names it: case-insensitive, a
    /// `[1m]`-style suffix dropped, then without its provider prefixes.
    pub fn lookup(&self, model: &str) -> Option<&ModelRate> {
        let key = model.trim().to_lowercase();
        let key = key.split('[').next().unwrap_or("");
        let bare = key.rsplit('/').next().unwrap_or(key);
        if bare.is_empty() || UNPRICEABLE.contains(&bare) {
            return None;
        }
        let mut rest = key;
        loop {
            if let Some(rate) = self.models.get(rest) {
                return Some(rate);
            }
            rest = rest.split_once('/')?.1;
        }
    }

    /// `None` when the model has no price.
    pub fn price(&self, model: &str, counts: &Counts, fast: bool) -> Option<Priced> {
        Some(self.lookup(model)?.price(counts, fast))
    }

    pub fn parse(document: &Value, fetched_at: i64) -> RateTable {
        let mut models = HashMap::new();
        let Some(entries) = document.as_object() else {
            return RateTable { fetched_at: Some(fetched_at), models };
        };
        for (name, entry) in entries {
            let Some(standard) = rates(entry, "", None) else { continue };
            let fast = match entry.pointer("/provider_specific_entry/fast").and_then(Value::as_f64) {
                Some(m) if m > 0.0 => Some(scale(&standard, m)),
                _ => rates(entry, "_priority", Some(&standard)),
            };
            let key = name.trim().to_lowercase();
            if !key.is_empty() {
                models.insert(key, ModelRate { standard, fast });
            }
        }
        // Prefixed entries (`anthropic/claude-x`) also answer to the bare
        // name, unless resellers disagree on its price.
        let mut aliases: HashMap<String, Option<ModelRate>> = HashMap::new();
        for (key, rate) in &models {
            let Some((_, bare)) = key.rsplit_once('/') else { continue };
            if bare.is_empty() || models.contains_key(bare) {
                continue;
            }
            aliases
                .entry(bare.to_owned())
                .and_modify(|held| {
                    if held.is_some_and(|h| h.standard != rate.standard) {
                        *held = None;
                    }
                })
                .or_insert(Some(*rate));
        }
        for (alias, rate) in aliases {
            if let Some(rate) = rate {
                models.insert(alias, rate);
            }
        }
        RateTable { fetched_at: Some(fetched_at), models }
    }
}

fn rates(entry: &Value, suffix: &str, standard: Option<&Rates>) -> Option<Rates> {
    let field = |name: &str| entry.get(format!("{name}{suffix}")).and_then(Value::as_f64).filter(|v| v.is_finite());
    let input = field("input_cost_per_token")?;
    let output = field("output_cost_per_token")?;
    // A missing cache rate keeps the standard tier's ratio, else the input rate.
    let derived = |pick: fn(&Rates) -> f64| match standard {
        Some(s) if s.input > 0.0 => pick(s) / s.input * input,
        _ => input,
    };
    let cache_read = field("cache_read_input_token_cost").unwrap_or_else(|| derived(|s| s.cache_read));
    let cache_write =
        field("cache_creation_input_token_cost").unwrap_or_else(|| derived(|s| s.cache_write));
    let cache_write_1h = field("cache_creation_input_token_cost_above_1hr").unwrap_or_else(|| match standard {
        Some(s) if s.input > 0.0 => s.cache_write_1h / s.input * input,
        _ => cache_write,
    });
    Some(Rates { input, output, cache_read, cache_write, cache_write_1h })
}

fn scale(r: &Rates, m: f64) -> Rates {
    Rates {
        input: r.input * m,
        output: r.output * m,
        cache_read: r.cache_read * m,
        cache_write: r.cache_write * m,
        cache_write_1h: r.cache_write_1h * m,
    }
}

pub fn load(path: &Path) -> RateTable {
    std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

pub fn save(path: &Path, table: &RateTable) {
    if let Ok(bytes) = serde_json::to_vec(table) {
        crate::write_atomic(path, &bytes);
    }
}

pub async fn fetch(now: i64) -> Result<RateTable, String> {
    let client = client()?;
    let response = client
        .get(URL)
        .send()
        .await
        .map_err(|e| format!("Couldn't fetch prices: {}", e.without_url()))?;
    if !response.status().is_success() {
        return Err(format!("Prices answered {}", response.status().as_u16()));
    }
    let document: Value =
        response.json().await.map_err(|e| format!("Couldn't read prices: {e}"))?;
    let table = RateTable::parse(&document, now);
    if table.models.is_empty() {
        return Err("The price table was empty".into());
    }
    Ok(table)
}

fn client() -> Result<&'static reqwest::Client, String> {
    static CLIENT: OnceLock<Result<reqwest::Client, String>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            // Fails when one is already installed, which is fine.
            let _ = rustls::crypto::ring::default_provider().install_default();
            reqwest::Client::builder()
                .timeout(TIMEOUT)
                .user_agent("hive-usage")
                .build()
                .map_err(|e| e.to_string())
        })
        .as_ref()
        .map_err(Clone::clone)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn table() -> RateTable {
        RateTable::parse(
            &json!({
                "claude-opus-5-5": {
                    "input_cost_per_token": 0.000004, "output_cost_per_token": 0.00002,
                    "cache_read_input_token_cost": 2e-7, "cache_creation_input_token_cost": 0.000005,
                    "cache_creation_input_token_cost_above_1hr": 0.000008,
                    "provider_specific_entry": { "fast": 2 }
                },
                "gpt-6-sol": {
                    "input_cost_per_token": 0.000002, "output_cost_per_token": 0.00001,
                    "cache_read_input_token_cost": 2e-7,
                    "input_cost_per_token_priority": 0.000004, "output_cost_per_token_priority": 0.00002
                },
                "openrouter/deepseek/deepseek-v4": { "input_cost_per_token": 1e-7, "output_cost_per_token": 2e-7 },
                "other/deepseek-v4": { "input_cost_per_token": 3e-7, "output_cost_per_token": 2e-7 },
                "sample_spec": { "input_cost_per_token": "nope" }
            }),
            1,
        )
    }

    #[test]
    fn prices_by_token_type() {
        let t = table();
        // input, cache read, cache write (1h part 100), output.
        let p = t.price("claude-opus-5-5", &[1000, 10_000, 300, 500, 0, 100], false).unwrap();
        assert!((p.input - 0.004).abs() < 1e-12);
        assert!((p.cache_read - 0.002).abs() < 1e-12);
        assert!((p.cache_write - (200.0 * 0.000005 + 100.0 * 0.000008)).abs() < 1e-12);
        assert!((p.output - 0.01).abs() < 1e-12);
        assert!((p.savings - 10_000.0 * (0.000004 - 2e-7)).abs() < 1e-12);

        let fast = t.price("claude-opus-5-5[1m]", &[1000, 0, 0, 0, 0, 0], true).unwrap();
        assert!((fast.input - 0.008).abs() < 1e-12);
        assert!((fast.fast_premium - 0.004).abs() < 1e-12);

        // Priority tier derives the missing cache rate from the standard ratio.
        let gpt = t.price("gpt-6-sol", &[0, 1000, 0, 0, 0, 0], true).unwrap();
        assert!((gpt.cache_read - 1000.0 * 4e-7).abs() < 1e-12);
    }

    #[test]
    fn looks_up_prefixed_and_unknown_models() {
        let t = table();
        assert!(t.lookup("openrouter/deepseek/deepseek-v4").is_some());
        // Two resellers disagree: no bare alias.
        assert!(t.lookup("deepseek-v4").is_none());
        assert!(t.lookup("anthropic/claude-opus-5-5").is_some());
        assert!(t.lookup("opus").is_none());
        assert!(t.lookup("<synthetic>").is_none());
        assert!(t.lookup("sample_spec").is_none());
    }
}
