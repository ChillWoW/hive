//! Codex's CLI as a provider: its version (`codex --version`), its account
//! and plan usage (`account/read`, `account/rateLimits/read` on an
//! app-server), installing it (OpenAI's install script), updating it
//! (`codex update`), and signing in and out.
//!
//! Sign-in is ChatGPT's browser flow through the app-server
//! (`account/login/start`): the server takes the browser's redirect itself,
//! so there's no code to paste; [`SignIn::finish`] waits for
//! `account/login/completed`.

use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use outcode_proto::{ProviderAccount, ProviderStatus, UsageWindow};
use serde_json::{Value, json};
use tokio::process::Command;
use tokio::sync::Notify;

use super::find;
use super::rpc::{Incoming, Server, retire};
use crate::{HarnessError, cli};

const PROBE_TIMEOUT: Duration = Duration::from_secs(20);
const UPDATE_TIMEOUT: Duration = Duration::from_secs(10 * 60);
/// How long a sign-in waits on the browser.
const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(10 * 60);

fn failed(message: impl Into<String>) -> HarnessError {
    HarnessError::Probe(message.into())
}

/// A command of the CLI's own, its output captured.
fn command(exe: &Path) -> Command {
    let mut cmd = cli::command(exe);
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    cmd
}

/// Runs `cmd`; its stdout when it succeeds, else what it said went wrong.
async fn run_ok(mut cmd: Command, timeout: Duration) -> Result<String, HarnessError> {
    let child = cmd.kill_on_drop(true).spawn().map_err(|e| failed(e.to_string()))?;
    let out = tokio::time::timeout(timeout, child.wait_with_output())
        .await
        .map_err(|_| failed("Codex took too long to answer."))?
        .map_err(|e| failed(e.to_string()))?;
    let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
    if out.status.success() {
        return Ok(stdout);
    }
    let stderr = String::from_utf8_lossy(&out.stderr);
    let text = if stderr.trim().is_empty() { stdout.as_str() } else { &stderr };
    let lines: Vec<&str> = text.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    Err(failed(lines[lines.len().saturating_sub(4)..].join("\n")))
}

/// Asks the app-server each of `calls` in turn, on one server started for
/// them: each one's answer.
async fn ask(exe: &Path, calls: Vec<(&'static str, Value)>) -> Result<Vec<Result<Value, HarnessError>>, HarnessError> {
    let server = tokio::time::timeout(PROBE_TIMEOUT, Server::start(exe, None))
        .await
        .map_err(|_| failed("codex app-server didn't start"))??;
    let Server {
        client,
        incoming,
        mut child,
        ..
    } = server;
    drop(incoming);
    let mut answers = Vec::new();
    for (method, params) in calls {
        answers.push(match tokio::time::timeout(PROBE_TIMEOUT, client.request(method, params)).await {
            Ok(answer) => answer.map_err(failed),
            Err(_) => Err(failed(format!("codex didn't answer {method}"))),
        });
    }
    drop(client);
    tokio::spawn(async move { retire(&mut child).await });
    Ok(answers)
}

/// The installed CLI, its version and who is signed in.
pub async fn status(binary: Option<&Path>) -> ProviderStatus {
    let Ok(exe) = find(binary) else {
        return ProviderStatus::default();
    };
    let mut status = ProviderStatus {
        installed: true,
        path: Some(exe.display().to_string()),
        ..ProviderStatus::default()
    };
    let mut version = command(&exe);
    version.arg("--version");
    let account = ask(&exe, vec![("account/read", json!({}))]);
    let (version, account) = tokio::join!(run_ok(version, PROBE_TIMEOUT), account);

    let mut errors = Vec::new();
    match version {
        Ok(out) => status.version = parse_version(&out),
        Err(e) => errors.push(format!("Version check failed: {e}")),
    }
    match account {
        Ok(mut answers) => match answers.remove(0) {
            Ok(answer) => status.account = Some(parse_account(&answer)),
            Err(e) => errors.push(format!("Login check failed: {e}")),
        },
        Err(e) => errors.push(format!("Login check failed: {e}")),
    }
    if !errors.is_empty() {
        status.error = Some(errors.join(" "));
    }
    status
}

/// The first `x.y.z` in `text` (`codex-cli 0.167.1`).
fn parse_version(text: &str) -> Option<String> {
    text.split_whitespace()
        .map(|word| word.trim_start_matches('v'))
        .find(|word| {
            let parts: Vec<&str> = word.split('.').collect();
            parts.len() >= 3 && parts.iter().take(3).all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()))
        })
        .map(str::to_owned)
}

/// An `account/read` answer.
fn parse_account(result: &Value) -> ProviderAccount {
    let account = &result["account"];
    let field = |key: &str| account[key].as_str().filter(|s| !s.is_empty()).map(str::to_owned);
    ProviderAccount {
        logged_in: account.is_object(),
        method: field("type").map(|t| match t.as_str() {
            "chatgpt" => "ChatGPT".into(),
            "apiKey" => "api-key".into(),
            "amazonBedrock" => "Amazon Bedrock".into(),
            "gcp" => "Google Cloud".into(),
            _ => t,
        }),
        email: field("email"),
        organization: field("workspaceName"),
        plan: field("planType").filter(|p| p != "unknown"),
    }
}

/// The ChatGPT plan's rate-limit windows; `None` without a ChatGPT login.
pub async fn usage(binary: Option<&Path>) -> Result<Option<Vec<UsageWindow>>, HarnessError> {
    let exe = find(binary)?;
    let mut answers = ask(&exe, vec![("account/read", json!({})), ("account/rateLimits/read", Value::Null)]).await?;
    let limits = answers.pop().expect("asked two");
    let account = answers.pop().expect("asked two")?;
    // API keys and the rest have no plan; their limits may not even read.
    if account["account"]["type"].as_str() != Some("chatgpt") {
        return Ok(None);
    }
    let windows = usage_windows(&limits?);
    Ok((!windows.is_empty()).then_some(windows))
}

/// One meter per window: the main limit's, then any other limits'.
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
pub async fn install() -> Result<(), HarnessError> {
    let mut cmd = if cfg!(windows) {
        let mut cmd = cli::command(Path::new("powershell"));
        cmd.args([
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            "irm https://chatgpt.com/codex/install.ps1 | iex",
        ]);
        cmd
    } else {
        let mut cmd = cli::command(Path::new("sh"));
        cmd.args(["-c", "curl -fsSL https://chatgpt.com/codex/install.sh | sh"]);
        cmd
    };
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    run_ok(cmd, UPDATE_TIMEOUT).await?;
    if find(None).is_err() {
        return Err(failed(
            "The installer finished, but `codex` wasn't found. Add it to PATH and restart Outcode.",
        ));
    }
    Ok(())
}

/// `codex update`.
pub async fn update(binary: Option<&Path>) -> Result<(), HarnessError> {
    let mut cmd = command(&find(binary)?);
    cmd.arg("update");
    run_ok(cmd, UPDATE_TIMEOUT).await.map(drop)
}

/// `codex logout`.
pub async fn sign_out(binary: Option<&Path>) -> Result<(), HarnessError> {
    let mut cmd = command(&find(binary)?);
    cmd.arg("logout");
    run_ok(cmd, PROBE_TIMEOUT).await.map(drop)
}

/// A ChatGPT sign-in waiting on the browser. Dropping it stops its server,
/// which ends the login.
pub struct SignIn {
    server: Server,
    login_id: String,
    url: String,
    cancel: Arc<Notify>,
}

/// Cancels a [`SignIn`] from elsewhere; cheap to clone.
#[derive(Clone)]
pub struct SignInControl {
    cancel: Arc<Notify>,
}

impl SignInControl {
    pub fn cancel(&self) {
        self.cancel.notify_one();
    }
}

impl SignIn {
    /// The page that finishes it, for the browser.
    pub fn url(&self) -> &str {
        &self.url
    }

    pub fn control(&self) -> SignInControl {
        SignInControl {
            cancel: Arc::clone(&self.cancel),
        }
    }

    /// Waits for the browser to finish, a cancel, or [`SIGN_IN_TIMEOUT`].
    pub async fn finish(self) -> Result<(), HarnessError> {
        let Self {
            server:
                Server {
                    client,
                    mut incoming,
                    mut child,
                    ..
                },
            login_id,
            cancel,
            ..
        } = self;
        let deadline = tokio::time::sleep(SIGN_IN_TIMEOUT);
        tokio::pin!(deadline);
        let outcome = loop {
            tokio::select! {
                message = incoming.recv() => match message {
                    Some(Incoming::Notification { method, params }) if method == "account/login/completed" => {
                        if !params["loginId"].as_str().is_none_or(|id| id == login_id) {
                            continue;
                        }
                        if params["success"].as_bool() == Some(true) {
                            break Ok(());
                        }
                        let error = params["error"].as_str().unwrap_or("Sign-in failed.");
                        break Err(failed(error));
                    }
                    Some(_) => {}
                    None => break Err(failed("Codex stopped before the sign-in finished.")),
                },
                () = cancel.notified() => {
                    let _ = tokio::time::timeout(
                        PROBE_TIMEOUT,
                        client.request("account/login/cancel", json!({ "loginId": login_id })),
                    )
                    .await;
                    break Err(failed("Sign-in cancelled."));
                }
                () = &mut deadline => break Err(failed("The sign-in timed out.")),
            }
        };
        drop(client);
        drop(incoming);
        retire(&mut child).await;
        outcome
    }
}

/// Starts ChatGPT's browser sign-in; open [`SignIn::url`], then
/// [`SignIn::finish`].
pub async fn start_sign_in(binary: Option<&Path>) -> Result<SignIn, HarnessError> {
    let exe = find(binary)?;
    let server = tokio::time::timeout(PROBE_TIMEOUT, Server::start(&exe, None))
        .await
        .map_err(|_| failed("codex app-server didn't start"))??;
    let started = tokio::time::timeout(
        PROBE_TIMEOUT,
        server.client.request("account/login/start", json!({ "type": "chatgpt" })),
    )
    .await
    .map_err(|_| failed("Codex didn't start the sign-in."))?
    .map_err(failed)?;
    let (Some(login_id), Some(url)) = (started["loginId"].as_str(), started["authUrl"].as_str()) else {
        return Err(failed("Codex didn't give a sign-in link."));
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
        let account = parse_account(&json!({"account": {
            "type": "chatgpt", "email": "a@b.c", "planType": "plus", "workspaceName": null
        }}));
        assert!(account.logged_in);
        assert_eq!(account.method.as_deref(), Some("ChatGPT"));
        assert_eq!(account.email.as_deref(), Some("a@b.c"));
        assert_eq!(account.plan.as_deref(), Some("plus"));
        let key = parse_account(&json!({"account": {"type": "apiKey"}}));
        assert_eq!((key.logged_in, key.method.as_deref()), (true, Some("api-key")));
        assert!(!parse_account(&json!({"account": null, "requiresOpenaiAuth": true})).logged_in);
    }

    #[test]
    fn rate_limits_become_windows() {
        let windows = usage_windows(&json!({
            "rateLimits": {"limitId": "codex",
                "primary": {"usedPercent": 22, "windowDurationMins": 300, "resetsAt": 1795888188},
                "secondary": {"usedPercent": 5, "windowDurationMins": 10080, "resetsAt": null}},
            "rateLimitsByLimitId": {
                "codex": {},
                "spark": {"limitName": "Spark", "primary": {"usedPercent": 50, "windowDurationMins": 10080}, "secondary": null}
            }
        }));
        assert_eq!(windows.len(), 3);
        assert_eq!(windows[0].label, "5 hours");
        assert!((windows[0].used - 0.22).abs() < 1e-9);
        assert_eq!(windows[0].resets_at.as_deref(), Some("2026-11-28T17:49:48Z"));
        assert_eq!(windows[1].label, "Week");
        assert_eq!(windows[1].resets_at, None);
        assert_eq!(windows[2].label, "Week · Spark");
    }

    #[test]
    fn versions_and_times_parse() {
        assert_eq!(parse_version("codex-cli 0.167.1\n").as_deref(), Some("0.167.1"));
        assert_eq!(rfc3339(0), "1970-01-01T00:00:00Z");
        assert_eq!(rfc3339(951_782_400), "2000-02-29T00:00:00Z");
    }

    /// Reads this machine's codex: `cargo test -p outcode-harness codex::provider -- --ignored --nocapture`.
    #[tokio::test]
    #[ignore = "needs codex installed and signed in"]
    async fn live_status_and_usage() {
        let status = status(None).await;
        println!("{status:?}");
        assert!(status.installed && status.version.is_some(), "{status:?}");
        assert!(status.account.as_ref().is_some_and(|a| a.logged_in), "{status:?}");
        let usage = usage(None).await.unwrap();
        println!("{usage:?}");
    }
}
