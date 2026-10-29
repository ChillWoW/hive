//! The Usage panel: tokens and estimated cost from every coding-agent CLI on
//! this machine, read from their own history (not only Hive's chats), priced
//! with a public rate table. `hive-usage` builds a [`UsageReport`] for a
//! [`UsageQuery`].

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::agent::HarnessId;

/// A time range split into buckets (hours or local days). The frontend sends
/// the boundaries, so days follow its time zone and DST without the backend
/// knowing either.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct UsageQuery {
    /// Each bucket's start, Unix ms, ascending. The first is the range's start.
    pub buckets: Vec<i64>,
    /// The range's end (exclusive), Unix ms.
    pub until: i64,
    /// Fetch the rate table again first (the Refresh button).
    #[serde(default)]
    pub refresh_prices: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct UsageReport {
    /// One row per (bucket, harness, model) with any usage.
    pub rows: Vec<UsageRow>,
    /// Totals per harness and model over the whole range, with session counts
    /// (which don't add up across buckets).
    pub models: Vec<UsageModel>,
    pub harnesses: Vec<UsageHarness>,
    /// Per project folder, most expensive first (capped).
    pub projects: Vec<UsageProject>,
    /// Distinct sessions in the range.
    pub sessions: u32,
    /// Where each harness's history was read from.
    pub sources: Vec<UsageSource>,
    pub pricing: UsagePricing,
    /// Unix ms.
    pub read_at: i64,
    pub scan_ms: u32,
}

/// Token counts. `input` is uncached input only; `reasoning` is part of
/// `output` (shown on its own, never added).
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct UsageTokens {
    pub input: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    pub output: u64,
    pub reasoning: u64,
}

impl UsageTokens {
    pub fn total(&self) -> u64 {
        self.input + self.cache_read + self.cache_write + self.output
    }

    pub fn add(&mut self, other: &UsageTokens) {
        self.input += other.input;
        self.cache_read += other.cache_read;
        self.cache_write += other.cache_write;
        self.output += other.output;
        self.reasoning += other.reasoning;
    }
}

/// Estimated USD by token type. `other` is cost the CLI reported for a model
/// the rate table doesn't know, so it can't be split.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct UsageCost {
    pub input: f64,
    pub cache_read: f64,
    pub cache_write: f64,
    pub output: f64,
    pub other: f64,
    /// What reading from cache saved over paying the input rate (not part of
    /// the total).
    pub savings: f64,
    /// The part of the total that came from fast mode's higher rates.
    pub fast_premium: f64,
}

impl UsageCost {
    pub fn total(&self) -> f64 {
        self.input + self.cache_read + self.cache_write + self.output + self.other
    }

    pub fn add(&mut self, other: &UsageCost) {
        self.input += other.input;
        self.cache_read += other.cache_read;
        self.cache_write += other.cache_write;
        self.output += other.output;
        self.other += other.other;
        self.savings += other.savings;
        self.fast_premium += other.fast_premium;
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct UsageRow {
    /// Index into [`UsageQuery::buckets`].
    pub bucket: u32,
    pub harness: HarnessId,
    pub model: String,
    pub tokens: UsageTokens,
    pub cost: UsageCost,
    /// Model requests.
    pub requests: u32,
    /// Requests with no price (unknown model, no reported cost); their tokens
    /// count, their cost doesn't.
    pub unpriced: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct UsageModel {
    pub harness: HarnessId,
    pub model: String,
    pub sessions: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct UsageHarness {
    pub harness: HarnessId,
    pub sessions: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct UsageProject {
    /// The folder the agent ran in.
    pub path: String,
    /// Each harness that worked here, most tokens first.
    pub harnesses: Vec<UsageProjectHarness>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct UsageProjectHarness {
    pub harness: HarnessId,
    /// Processed tokens.
    pub tokens: u64,
    pub cost: f64,
    pub sessions: u32,
    pub requests: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum UsageSourceStatus {
    Ok,
    /// Nothing there: the CLI was never used on this machine.
    Missing,
    /// Read, but some of it couldn't be.
    Partial,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct UsageSource {
    pub harness: HarnessId,
    pub status: UsageSourceStatus,
    /// Where it was read from.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// Files read for this range (a database counts as one).
    pub files: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum UsagePricingStatus {
    /// Fetched today.
    Fresh,
    /// An older copy; the fetch failed or wasn't due.
    Cached,
    /// No rate table: only CLI-reported costs count.
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct UsagePricing {
    pub status: UsagePricingStatus,
    /// When the table was fetched, Unix ms.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fetched_at: Option<i64>,
    /// Models with a price.
    pub models: u32,
}
