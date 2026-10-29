//! How much of the subscription's rate limits the CLI's login has used, as
//! Claude's `/usage` shows it: `GET /api/oauth/usage` with the CLI's own
//! OAuth token (as zeron does). The token is only read, never refreshed:
//! the CLI holds the single-use refresh token and renews it as it runs.

use std::sync::OnceLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use hive_proto::{ProviderUsage, UsageWindow};
use serde_json::Value;

use super::find_claude;
use super::provider::{cli, config_dir, parse_version, run};
use crate::provider::ProviderError;

const USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
const TIMEOUT: Duration = Duration::from_secs(15);
/// Used when the installed CLI's version can't be read.
const FALLBACK_CLI_VERSION: &str = "2.1.0";

/// The windows of the signed-in subscription; `None` when there's no
/// subscription login to ask about (signed out, or an API key / Console).
pub async fn usage() -> Result<Option<ProviderUsage>, ProviderError> {
    let Some(credentials) = read_credentials().await else {
        return Ok(None);
    };
    let Some(oauth) = credentials.get("claudeAiOauth") else {
        return Ok(None);
    };
    let Some(token) = oauth.get("accessToken").and_then(Value::as_str) else {
        return Ok(None);
    };
    // Some CLI versions wrote 0 for fresh logins, so only a real past time counts.
    let expires_at = oauth.get("expiresAt").and_then(Value::as_u64).unwrap_or(0);
    if expires_at > 0 && expires_at < now_ms() {
        return Err(expired());
    }

    let response = client()?
        .get(USAGE_URL)
        .bearer_auth(token)
        .header(reqwest::header::USER_AGENT, user_agent().await)
        .header("anthropic-beta", "oauth-2025-04-20")
        .send()
        .await
        .map_err(|e| ProviderError::Failed(format!("Couldn't reach Claude: {}", e.without_url())))?;
    match response.status().as_u16() {
        200..=299 => {}
        401 | 403 => return Err(expired()),
        429 => return Err(ProviderError::Failed("Claude is rate-limiting usage checks".into())),
        status => return Err(ProviderError::Failed(format!("Claude answered {status}"))),
    }
    let body: Value = response
        .json()
        .await
        .map_err(|e| ProviderError::Failed(format!("Couldn't read the usage reply: {e}")))?;
    let windows = parse_windows(&body);
    Ok((!windows.is_empty()).then_some(ProviderUsage { windows }))
}

fn expired() -> ProviderError {
    ProviderError::Failed("The login has expired; Claude renews it on its next turn".into())
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

fn client() -> Result<&'static reqwest::Client, ProviderError> {
    static CLIENT: OnceLock<Result<reqwest::Client, String>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            // Fails when one is already installed, which is fine.
            let _ = rustls::crypto::ring::default_provider().install_default();
            reqwest::Client::builder()
                .timeout(TIMEOUT)
                .build()
                .map_err(|e| e.to_string())
        })
        .as_ref()
        .map_err(|e| ProviderError::Failed(e.clone()))
}

/// `claude-code/<version>`: the endpoint answers 429 at once to any other
/// agent (even a bare `claude-code`), but serves the CLI's own. The
/// installed CLI's version, read once.
async fn user_agent() -> &'static str {
    static AGENT: tokio::sync::OnceCell<String> = tokio::sync::OnceCell::const_new();
    AGENT
        .get_or_init(|| async {
            let version = match find_claude() {
                Some(exe) => {
                    let mut cmd = cli(&exe);
                    cmd.arg("--version");
                    run(cmd, TIMEOUT)
                        .await
                        .ok()
                        .filter(|out| out.success)
                        .and_then(|out| parse_version(&out.stdout))
                }
                None => None,
            };
            format!("claude-code/{}", version.as_deref().unwrap_or(FALLBACK_CLI_VERSION))
        })
        .await
}

/// The CLI's stored login: the macOS Keychain first (where it keeps it
/// there), else `.credentials.json` in its config folder.
async fn read_credentials() -> Option<Value> {
    #[cfg(target_os = "macos")]
    if let Some(json) = keychain().await {
        return Some(json);
    }
    let path = config_dir()?.join(".credentials.json");
    let text = tokio::fs::read_to_string(path).await.ok()?;
    serde_json::from_str(&text).ok()
}

#[cfg(target_os = "macos")]
async fn keychain() -> Option<Value> {
    let out = tokio::time::timeout(
        TIMEOUT,
        // Absolute path: a `security` planted on PATH must never see it.
        tokio::process::Command::new("/usr/bin/security")
            .args(["find-generic-password", "-s", &keychain_service(), "-w"])
            .stdin(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .output(),
    )
    .await
    .ok()?
    .ok()?;
    if !out.status.success() {
        return None;
    }
    serde_json::from_slice(&out.stdout).ok()
}

/// `Claude Code-credentials`, suffixed with the first 8 hex digits of
/// sha256(config dir) when `CLAUDE_CONFIG_DIR` moves the config.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn keychain_service() -> String {
    use sha2::{Digest, Sha256};
    match std::env::var_os("CLAUDE_CONFIG_DIR") {
        None => "Claude Code-credentials".into(),
        Some(dir) => {
            let digest = Sha256::digest(dir.to_string_lossy().as_bytes());
            let hex: String = digest.iter().take(4).map(|b| format!("{b:02x}")).collect();
            format!("Claude Code-credentials-{hex}")
        }
    }
}

/// The reply's `limits` (session, weekly, weekly per model), else the older
/// `five_hour` / `seven_day` buckets.
fn parse_windows(body: &Value) -> Vec<UsageWindow> {
    let from_limits: Vec<UsageWindow> = body
        .get("limits")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(limit_window)
        .collect();
    if !from_limits.is_empty() {
        return from_limits;
    }
    [("five_hour", "Session"), ("seven_day", "Week")]
        .into_iter()
        .filter_map(|(key, label)| {
            let bucket = body.get(key)?;
            Some(UsageWindow {
                label: label.into(),
                used: fraction(bucket.get("utilization")?.as_f64()?),
                resets_at: string(bucket.get("resets_at")),
            })
        })
        .collect()
}

/// `{"kind": "weekly_scoped", "percent": 3, "resets_at": …, "scope": {"model": {"display_name": "Opus"}}}`.
fn limit_window(limit: &Value) -> Option<UsageWindow> {
    let percent = limit.get("percent")?.as_f64()?;
    let model = limit
        .pointer("/scope/model/display_name")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty());
    let label = match (limit.get("group").and_then(Value::as_str), model) {
        (Some("session"), _) => "Session".to_owned(),
        (Some("weekly"), Some(model)) => format!("Week · {model}"),
        (Some("weekly"), None) => "Week".to_owned(),
        (_, Some(model)) => model.to_owned(),
        (Some(group), None) => capitalize(group),
        (None, None) => return None,
    };
    Some(UsageWindow {
        label,
        used: fraction(percent),
        resets_at: string(limit.get("resets_at")),
    })
}

fn fraction(percent: f64) -> f64 {
    (percent / 100.0).clamp(0.0, 1.0)
}

fn string(value: Option<&Value>) -> Option<String> {
    value?.as_str().filter(|s| !s.is_empty()).map(str::to_owned)
}

fn capitalize(text: &str) -> String {
    let mut chars = text.chars();
    chars
        .next()
        .map(|c| c.to_uppercase().chain(chars).collect())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_the_limits() {
        let body = json!({
            "five_hour": { "utilization": 22.0, "resets_at": "old" },
            "limits": [
                { "kind": "session", "group": "session", "percent": 22,
                  "resets_at": "2026-10-29T16:29:59+00:00", "scope": null },
                { "kind": "weekly_all", "group": "weekly", "percent": 15,
                  "resets_at": "2026-11-03T10:59:59+00:00", "scope": null },
                { "kind": "weekly_scoped", "group": "weekly", "percent": 0,
                  "scope": { "model": { "id": null, "display_name": "Opus" } } }
            ]
        });
        let windows = parse_windows(&body);
        let labels: Vec<_> = windows.iter().map(|w| w.label.as_str()).collect();
        assert_eq!(labels, ["Session", "Week", "Week · Opus"]);
        assert_eq!(windows[0].used, 0.22);
        assert_eq!(windows[0].resets_at.as_deref(), Some("2026-10-29T16:29:59+00:00"));
        assert_eq!(windows[2].resets_at, None);
    }

    #[test]
    fn falls_back_to_the_buckets() {
        let body = json!({
            "five_hour": { "utilization": 6.0, "resets_at": "2026-04-08T18:59:59Z" },
            "seven_day": { "utilization": 135.0, "resets_at": null },
            "seven_day_opus": null
        });
        let windows = parse_windows(&body);
        assert_eq!(windows.len(), 2);
        assert_eq!(windows[0].label, "Session");
        assert_eq!(windows[0].used, 0.06);
        assert_eq!(windows[1].used, 1.0);
        assert!(parse_windows(&json!({ "five_hour": {} })).is_empty());
    }

    #[test]
    fn suffixes_the_keychain_service_for_a_moved_config() {
        // Only the default case; the env var is process-wide.
        if std::env::var_os("CLAUDE_CONFIG_DIR").is_none() {
            assert_eq!(keychain_service(), "Claude Code-credentials");
        }
    }
}

#[cfg(test)]
mod live {
    /// Reads this machine's real usage: `cargo test -p hive-harness usage::live -- --ignored --nocapture`.
    #[tokio::test]
    #[ignore]
    async fn reads_real_usage() {
        let usage = super::usage().await.unwrap();
        println!("{usage:#?}");
    }
}
