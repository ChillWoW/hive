//! Claude Code as a provider (Settings › Claude): its status, signing in and
//! out, installing and updating it, the newest release, and the plan's usage.

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use outcode_harness::claude::provider::{self, SignInControl};
use outcode_proto::{ProviderStatus, SignInStarted, UsageWindow};
use serde_json::Value;
use tauri::{AppHandle, Manager, State};

use crate::settings::{Settings, SettingsFile};

const USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
const NPM_URL: &str = "https://registry.npmjs.org/@anthropic-ai/claude-code";
/// Used when the installed CLI's version can't be read.
const FALLBACK_CLI_VERSION: &str = "2.1.0";

/// Applies Settings › Claude › Advanced to every `claude` started from now on.
pub fn configure(settings: &Settings) {
    let claude = &settings.claude;
    outcode_harness::claude::configure(&claude.env, &claude.config_dir, &claude.launch_args);
}

/// `claude.binaryPath`, when set.
fn binary(app: &AppHandle) -> Option<PathBuf> {
    let binary = app.state::<SettingsFile>().get().claude.binary_path;
    (!binary.is_empty()).then(|| PathBuf::from(binary))
}

fn err(error: impl std::fmt::Display) -> String {
    error.to_string()
}

/// Whether Claude is installed, its version, and who is signed in.
#[tauri::command]
pub async fn claude_status(app: AppHandle) -> ProviderStatus {
    provider::status(binary(&app).as_deref()).await
}

/// The sign-in in progress, if any.
#[derive(Default)]
pub struct SignIns(Mutex<Option<SignInControl>>);

/// Starts signing in: the CLI opens the browser; the URL is the fallback
/// page, for when it didn't. [`claude_sign_in_wait`] waits for the end.
#[tauri::command]
pub async fn claude_sign_in_start(app: AppHandle, sign_ins: State<'_, SignIns>) -> Result<SignInStarted, String> {
    if let Some(old) = sign_ins.0.lock().unwrap().take() {
        old.cancel();
    }
    let sign_in = provider::start_sign_in(binary(&app).as_deref()).await.map_err(err)?;
    let url = sign_in.url().to_owned();
    *sign_ins.0.lock().unwrap() = Some(sign_in.control());
    // Finishes on its own; the frontend hears it through `claude_sign_in_wait`.
    let (tx, rx) = tokio::sync::oneshot::channel();
    tauri::async_runtime::spawn(async move {
        let _ = tx.send(sign_in.finish().await.map_err(err));
    });
    *app.state::<SignInResult>().0.lock().unwrap() = Some(rx);
    Ok(SignInStarted { url })
}

/// How the sign-in in progress ends.
#[derive(Default)]
pub struct SignInResult(Mutex<Option<tokio::sync::oneshot::Receiver<Result<(), String>>>>);

/// Waits for the sign-in in progress to finish.
#[tauri::command]
pub async fn claude_sign_in_wait(result: State<'_, SignInResult>, sign_ins: State<'_, SignIns>) -> Result<(), String> {
    let Some(rx) = result.0.lock().unwrap().take() else {
        return Err("No sign-in is in progress.".into());
    };
    let outcome = rx.await.unwrap_or_else(|_| Err("Sign-in ended.".into()));
    sign_ins.0.lock().unwrap().take();
    outcome
}

/// Pastes the code the fallback page shows.
#[tauri::command]
pub async fn claude_sign_in_code(sign_ins: State<'_, SignIns>, code: String) -> Result<(), String> {
    let control = sign_ins.0.lock().unwrap().clone();
    let Some(control) = control else {
        return Err("No sign-in is in progress.".into());
    };
    control.submit(&code).await.map_err(err)
}

#[tauri::command]
pub fn claude_sign_in_cancel(sign_ins: State<'_, SignIns>) {
    if let Some(control) = sign_ins.0.lock().unwrap().take() {
        control.cancel();
    }
}

#[tauri::command]
pub async fn claude_sign_out(app: AppHandle) -> Result<(), String> {
    provider::sign_out(binary(&app).as_deref()).await.map_err(err)
}

/// `claude update`.
#[tauri::command]
pub async fn claude_update(app: AppHandle) -> Result<(), String> {
    provider::update(binary(&app).as_deref()).await.map_err(err)
}

/// Runs Anthropic's installer.
#[tauri::command]
pub async fn claude_install() -> Result<(), String> {
    provider::install().await.map_err(err)
}

/// The newest release on npm (`latest` dist-tag).
#[tauri::command]
pub async fn claude_latest_version() -> Result<String, String> {
    let client = crate::http::client().ok_or("No HTTP client.")?;
    let body: Value = client
        .get(NPM_URL)
        .header(reqwest::header::ACCEPT, "application/vnd.npm.install-v1+json")
        .send()
        .await
        .map_err(|e| format!("Couldn't reach npm: {}", e.without_url()))?
        .json()
        .await
        .map_err(err)?;
    body.pointer("/dist-tags/latest")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| "npm didn't say which release is newest.".into())
}

/// How much of the plan's limits the CLI's login has used, as Claude's
/// `/usage` shows it; none without a subscription login. ⚠ The endpoint
/// answers 429 to any User-Agent but `claude-code/<installed version>`.
#[tauri::command]
pub async fn claude_usage(app: AppHandle) -> Result<Option<Vec<UsageWindow>>, String> {
    let Some(token) = provider::oauth_token().await.map_err(err)? else {
        return Ok(None);
    };
    let version = provider::version(binary(&app).as_deref())
        .await
        .unwrap_or_else(|| FALLBACK_CLI_VERSION.into());
    let client = crate::http::client().ok_or("No HTTP client.")?;
    let response = client
        .get(USAGE_URL)
        .bearer_auth(token)
        .header(reqwest::header::USER_AGENT, format!("claude-code/{version}"))
        .header("anthropic-beta", "oauth-2025-04-20")
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| format!("Couldn't reach Claude: {}", e.without_url()))?;
    match response.status().as_u16() {
        200..=299 => {}
        401 | 403 => return Err("The login has expired; Claude renews it on its next turn.".into()),
        429 => return Err("Claude is rate-limiting usage checks; try again in a minute.".into()),
        status => return Err(format!("Claude answered {status}.")),
    }
    let body: Value = response.json().await.map_err(err)?;
    let windows = parse_windows(&body);
    Ok((!windows.is_empty()).then_some(windows))
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
    [("five_hour", "Session"), ("seven_day", "Week"), ("seven_day_opus", "Week · Opus")]
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
        (Some(group), None) => {
            let mut chars = group.chars();
            chars.next().map(|c| c.to_uppercase().chain(chars).collect()).unwrap_or_default()
        }
        (None, None) => return None,
    };
    Some(UsageWindow {
        label,
        used: fraction(percent),
        resets_at: string(limit.get("resets_at")),
    })
}

/// A percentage (0–100) as a fraction, clamped.
fn fraction(percent: f64) -> f64 {
    (percent / 100.0).clamp(0.0, 1.0)
}

fn string(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_owned)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn usage_reads_both_shapes() {
        let windows = parse_windows(&json!({ "limits": [
            { "group": "session", "percent": 40, "resets_at": "2026-01-01T00:00:00Z" },
            { "group": "weekly", "percent": 12 },
            { "group": "weekly", "percent": 3, "scope": { "model": { "display_name": "Opus" } } },
        ] }));
        let labels: Vec<&str> = windows.iter().map(|w| w.label.as_str()).collect();
        assert_eq!(labels, ["Session", "Week", "Week · Opus"]);
        assert!((windows[0].used - 0.4).abs() < 1e-9);

        let old = parse_windows(&json!({ "five_hour": { "utilization": 150 }, "seven_day": null }));
        assert_eq!(old.len(), 1);
        assert!((old[0].used - 1.0).abs() < 1e-9);
    }
}
