//! The agent CLI as a provider: whether it's installed, which version, who
//! is signed in, and how much of the plan's limits is used.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ProviderStatus {
    pub installed: bool,
    /// Where the CLI is.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account: Option<ProviderAccount>,
    /// What went wrong reading the rest.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ProviderAccount {
    pub logged_in: bool,
    /// How: a Claude subscription, the Console, an API key.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub method: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub organization: Option<String>,
    /// The subscription (`pro`, `max`, …).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan: Option<String>,
}

/// One of the plan's rate-limit windows.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct UsageWindow {
    /// "Session", "Week", "Week · Opus".
    pub label: String,
    /// 0 to 1.
    pub used: f64,
    /// When it resets, as the API says it (an ISO 8601 time).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resets_at: Option<String>,
}

/// A sign-in in progress: the page that finishes it, should the browser not
/// have opened by itself.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SignInStarted {
    pub url: String,
}
