//! A harness's CLI as Settings › Providers shows it: where it is, which
//! version, who it's signed in as.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::agent::HarnessId;

/// One probe of a harness's CLI. Cheap enough to take whenever the page
/// opens; nothing in it is cached.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ProviderStatus {
    pub harness: HarnessId,
    /// The CLI was found (or the harness needs none).
    pub installed: bool,
    /// Where the CLI was found.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// e.g. `"2.1.312"`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// The release channel the CLI updates from (`"latest"`, `"stable"`),
    /// for comparing against the newest release.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub update_channel: Option<String>,
    /// Missing when the CLI can't say (not installed, or the check failed).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account: Option<ProviderAccount>,
    /// Why part of the probe failed, for the row's meta line.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Hive can run the CLI's installer (offered while not installed).
    pub can_install: bool,
    /// Hive can update the CLI in place.
    pub can_update: bool,
    /// Hive can sign the CLI in and out.
    pub can_sign_in: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ProviderAccount {
    pub logged_in: bool,
    /// How it authenticates: `"claude.ai"`, `"console"`, `"api-key"`, ….
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub method: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub organization: Option<String>,
    /// The subscription, e.g. `"max"`, `"pro"`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan: Option<String>,
}

/// Which account a sign-in is for.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum SignInMethod {
    /// A Claude subscription (Pro, Max, Team, Enterprise).
    #[default]
    Subscription,
    /// An Anthropic Console account, billed per API use.
    Console,
}

/// A sign-in waiting for the code the browser shows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SignInStarted {
    pub login_id: String,
    /// The page to approve access on; the CLI already tried to open it.
    pub url: String,
}

/// How much of a subscription's rate limits the signed-in account has used,
/// one meter per window (as Claude's `/usage` shows them).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ProviderUsage {
    pub windows: Vec<UsageWindow>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct UsageWindow {
    /// e.g. `"Session"`, `"Week"`, `"Week · Opus"`.
    pub label: String,
    /// Share of the window used, 0–1.
    pub used: f64,
    /// When it starts over, RFC 3339.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resets_at: Option<String>,
}
