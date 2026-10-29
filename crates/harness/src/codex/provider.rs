//! Codex's CLI as a provider: its version (`codex --version`), its account
//! and plan usage (`account/read`, `account/rateLimits/read` on an
//! app-server), installing it (OpenAI's install script, as zeron runs it),
//! updating it (`codex update`), and signing in and out.
//!
//! Sign-in is ChatGPT's browser flow through the app-server
//! (`account/login/start`): the server listens for the browser's redirect
//! itself, so there's no code to paste; finishing waits for
//! `account/login/completed`.

use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use hive_proto::{HarnessId, ProviderAccount, ProviderStatus, ProviderUsage, UsageWindow};
use serde_json::{json, Value};
use tokio::process::Command;
use tokio::sync::Notify;

use super::find_codex;
use super::rpc::{Incoming, Server};
use crate::claude::command_for;
use crate::claude::provider::{no_window, parse_version, run};
use crate::provider::ProviderError;

const PROBE_TIMEOUT: Duration = Duration::from_secs(20);
const INSTALL_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const UPDATE_TIMEOUT: Duration = Duration::from_secs(10 * 60);
/// How long the browser sign-in may take.
const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(10 * 60);

fn installed() -> Result<std::path::PathBuf, ProviderError> {
    find_codex().ok_or(ProviderError::NotInstalled("codex"))
}

fn cli(exe: &std::path::Path) -> Command {
    let mut cmd = command_for(exe);
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    no_window(&mut cmd);
    cmd
}

pub async fn status() -> ProviderStatus {
    let mut status = ProviderStatus {
        harness: HarnessId::Codex,
        installed: false,
        path: None,
        version: None,
        // `@openai/codex`'s npm dist-tag, for the newest-release check.
        update_channel: None,
        account: None,
        error: None,
        can_install: true,
        can_update: false,
        can_sign_in: false,
    };
    let Some(exe) = find_codex() else {
        return status;
    };
    status.installed = true;
    status.path = Some(exe.display().to_string());
    status.can_update = true;
    status.can_sign_in = true;
    status.update_channel = Some("latest".into());

    let mut version = cli(&exe);
    version.arg("--version");
    let account = Server::one_shot(&exe, "", "account/read", json!({}), PROBE_TIMEOUT);
    let (version, account) = tokio::join!(run(version, PROBE_TIMEOUT), account);

    let mut errors = Vec::new();
    match version {
        Ok(out) if out.success => status.version = parse_version(&out.stdout),
        Ok(out) => errors.push(format!("version check failed: {}", out.failure())),
        Err(e) => errors.push(format!("version check failed: {e}")),
    }
    match account {
        Ok(result) => status.account = Some(parse_account(&result)),
        Err(e) => errors.push(format!("login check failed: {e}")),
    }
    if !errors.is_empty() {
        status.error = Some(errors.join("; "));
    }
    status
}

/// An `account/read` answer.
fn parse_account(result: &Value) -> ProviderAccount {
    let account = &result["account"];
    let field = |key: &str| {
        account[key]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
    };
    ProviderAccount {
        logged_in: account.is_object(),
        method: field("type").map(|t| match t.as_str() {
            "chatgpt" => "ChatGPT".into(),
            "apiKey" => "api-key".into(),
            "amazonBedrock" => "Amazon Bedrock".into(),
            _ => t,
        }),
        email: field("email"),
        organization: None,
        plan: field("planType"),
    }
}

/// The ChatGPT plan's rate limits; `None` for an API key (no plan).
pub async fn usage() -> Result<Option<ProviderUsage>, ProviderError> {
    let exe = installed()?;
    let account = Server::one_shot(&exe, "", "account/read", json!({}), PROBE_TIMEOUT)
        .await
        .map_err(ProviderError::Failed)?;
    if account["account"]["type"].as_str() != Some("chatgpt") {
        return Ok(None);
    }
    let limits = Server::one_shot(
        &exe,
        "",
        "account/rateLimits/read",
        Value::Null,
        PROBE_TIMEOUT,
    )
    .await
    .map_err(ProviderError::Failed)?;
    let windows = usage_windows(&limits);
    Ok((!windows.is_empty()).then_some(ProviderUsage { windows }))
}

/// One meter per window: the main limit's, then any per-model limits'.
fn usage_windows(result: &Value) -> Vec<UsageWindow> {
    let mut windows = Vec::new();
    let main = &result["rateLimits"];
    push_windows(&mut windows, main, None);
    if let Some(by_id) = result["rateLimitsByLimitId"].as_object() {
        for (id, snapshot) in by_id {
            if Some(id.as_str()) == main["limitId"].as_str() {
                continue;
            }
            let name = snapshot["limitName"].as_str().unwrap_or(id);
            push_windows(&mut windows, snapshot, Some(name));
        }
    }
    windows
}

fn push_windows(out: &mut Vec<UsageWindow>, snapshot: &Value, scope: Option<&str>) {
    for key in ["primary", "secondary"] {
        let window = &snapshot[key];
        let Some(used) = window["usedPercent"].as_f64() else {
            continue;
        };
        let span = window_label(window["windowDurationMins"].as_i64());
        out.push(UsageWindow {
            label: match scope {
                Some(scope) => format!("{span} · {scope}"),
                None => span,
            },
            used: (used / 100.0).clamp(0.0, 1.0),
            resets_at: window["resetsAt"].as_i64().map(rfc3339),
        });
    }
}

/// `300` → "5 hours", `10080` → "Week", `43200` → "Month".
fn window_label(minutes: Option<i64>) -> String {
    match minutes {
        Some(10_080) => "Week".into(),
        Some(m) if (40_000..=45_000).contains(&m) => "Month".into(),
        Some(1_440) => "Day".into(),
        Some(m) if m > 0 && m % 1_440 == 0 => format!("{} days", m / 1_440),
        Some(60) => "Hour".into(),
        Some(m) if m > 0 && m % 60 == 0 => format!("{} hours", m / 60),
        Some(m) if m > 0 => format!("{m} minutes"),
        _ => "Limit".into(),
    }
}

/// Unix seconds as RFC 3339 (UTC).
fn rfc3339(secs: i64) -> String {
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    // Howard Hinnant's civil-from-days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rem / 3_600,
        rem % 3_600 / 60,
        rem % 60
    )
}

/// Runs OpenAI's installer for this platform.
pub async fn install() -> Result<(), ProviderError> {
    let mut cmd = if cfg!(windows) {
        let mut cmd = Command::new("powershell.exe");
        cmd.args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            "irm https://chatgpt.com/codex/install.ps1 | iex",
        ]);
        cmd
    } else {
        let mut cmd = Command::new("/bin/sh");
        cmd.args(["-c", "curl -fsSL https://chatgpt.com/codex/install.sh | sh"]);
        cmd
    };
    cmd.env("CI", "1")
        .env("NONINTERACTIVE", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    no_window(&mut cmd);
    let out = run(cmd, INSTALL_TIMEOUT).await?;
    if !out.success {
        return Err(out.failure());
    }
    installed().map(|_| ()).map_err(|_| {
        ProviderError::Failed(
            "The installer finished, but `codex` wasn't found. Add it to PATH and restart Hive."
                .into(),
        )
    })
}

/// `codex update`.
pub async fn update() -> Result<(), ProviderError> {
    let mut cmd = cli(&installed()?);
    cmd.arg("update");
    let out = run(cmd, UPDATE_TIMEOUT).await?;
    if out.success {
        Ok(())
    } else {
        Err(out.failure())
    }
}

pub async fn sign_out() -> Result<(), ProviderError> {
    let mut cmd = cli(&installed()?);
    cmd.arg("logout");
    let out = run(cmd, PROBE_TIMEOUT).await?;
    if out.success {
        Ok(())
    } else {
        Err(out.failure())
    }
}

/// A ChatGPT sign-in waiting on the browser. Dropping it stops the server,
/// which ends the login.
pub struct SignIn {
    server: Server,
    login_id: String,
    url: String,
    cancel: Arc<Notify>,
}

impl SignIn {
    pub fn url(&self) -> &str {
        &self.url
    }

    /// Wakes a [`SignIn::finish`] in progress (or the next one) to cancel.
    pub fn canceller(&self) -> Arc<Notify> {
        Arc::clone(&self.cancel)
    }

    /// Waits for the browser to finish. The code is unused: the server takes
    /// the redirect itself.
    pub async fn finish(mut self) -> Result<(), ProviderError> {
        let deadline = tokio::time::sleep(SIGN_IN_TIMEOUT);
        tokio::pin!(deadline);
        loop {
            tokio::select! {
                message = self.server.incoming.recv() => match message {
                    Some(Incoming::Notification { method, params }) if method == "account/login/completed" => {
                        let ours = params["loginId"].as_str().is_none_or(|id| id == self.login_id);
                        if !ours {
                            continue;
                        }
                        if params["success"].as_bool() == Some(true) {
                            return Ok(());
                        }
                        let error = params["error"].as_str().unwrap_or("Sign-in failed.");
                        return Err(ProviderError::Failed(error.to_owned()));
                    }
                    Some(_) => {}
                    None => return Err(ProviderError::Failed("codex stopped before the sign-in finished".into())),
                },
                _ = self.cancel.notified() => {
                    let _ = self
                        .server
                        .client
                        .request("account/login/cancel", json!({ "loginId": self.login_id }))
                        .await;
                    return Err(ProviderError::Failed("Sign-in cancelled.".into()));
                }
                _ = &mut deadline => return Err(ProviderError::TimedOut),
            }
        }
    }
}

pub async fn start_sign_in() -> Result<SignIn, ProviderError> {
    let exe = installed()?;
    let server = Server::start(&exe, "")
        .await
        .map_err(|e| ProviderError::Failed(e.to_string()))?;
    let started = tokio::time::timeout(
        PROBE_TIMEOUT,
        server
            .client
            .request("account/login/start", json!({ "type": "chatgpt" })),
    )
    .await
    .map_err(|_| ProviderError::TimedOut)?
    .map_err(ProviderError::Failed)?;
    let (Some(login_id), Some(url)) = (started["loginId"].as_str(), started["authUrl"].as_str())
    else {
        return Err(ProviderError::Failed(
            "codex didn't give a sign-in link".into(),
        ));
    };
    Ok(SignIn {
        login_id: login_id.to_owned(),
        url: url.to_owned(),
        server,
        cancel: Arc::new(Notify::new()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_account() {
        let account = parse_account(
            &json!({"account": {"type": "chatgpt", "email": "a@b.c", "planType": "plus"}}),
        );
        assert!(account.logged_in);
        assert_eq!(account.method.as_deref(), Some("ChatGPT"));
        assert_eq!(account.plan.as_deref(), Some("plus"));
        assert!(!parse_account(&json!({"account": null})).logged_in);
    }

    #[test]
    fn rate_limits_become_windows() {
        let windows = usage_windows(&json!({
            "rateLimits": {"limitId": "codex",
                "primary": {"usedPercent": 22.0, "windowDurationMins": 300, "resetsAt": 1795888188},
                "secondary": {"usedPercent": 5.0, "windowDurationMins": 10080, "resetsAt": null}},
            "rateLimitsByLimitId": {
                "codex": {},
                "spark": {"limitName": "Spark", "primary": {"usedPercent": 50, "windowDurationMins": 10080, "resetsAt": null}, "secondary": null}
            }
        }));
        assert_eq!(windows.len(), 3);
        assert_eq!(windows[0].label, "5 hours");
        assert!((windows[0].used - 0.22).abs() < 1e-9);
        assert_eq!(
            windows[0].resets_at.as_deref(),
            Some("2026-11-28T17:49:48Z")
        );
        assert_eq!(windows[1].label, "Week");
        assert_eq!(windows[2].label, "Week · Spark");
    }

    #[test]
    fn formats_times() {
        assert_eq!(rfc3339(0), "1970-01-01T00:00:00Z");
        assert_eq!(rfc3339(951_782_400), "2000-02-29T00:00:00Z");
    }
}
