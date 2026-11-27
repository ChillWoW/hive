//! Antigravity's CLI as a provider: its version (`agy --version`), whether
//! it's signed in and the plan's quota (the print-mode `/credits` and
//! `/usage`, which answer without starting a turn or spending quota),
//! updating it (`agy update`), and signing in and out over ACP
//! (`authenticate`, `logout`).
//!
//! ⚠ Before 1.1.11 print mode sent a slash command to the model as a prompt,
//! so nothing is asked of a CLI older than [`MIN_VERSION`].

use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use outcode_proto::{ProviderAccount, ProviderStatus, UsageWindow};
use serde_json::{Value, json};
use tokio::process::Command;
use tokio::sync::Notify;

use super::acp::{Server, retire};
use super::find;
use crate::{HarnessError, cli};

/// The oldest `agy` Outcode drives: open model access over ACP.
pub const MIN_VERSION: [u32; 3] = [1, 5, 1];
pub const INSTALL_URL: &str = "https://antigravity.google/docs/getting-started";
/// Where Google's updater publishes each platform's newest release.
const MANIFEST_BASE: &str = "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests";

const PROBE_TIMEOUT: Duration = Duration::from_secs(30);
const UPDATE_TIMEOUT: Duration = Duration::from_secs(10 * 60);
/// How long a sign-in waits on the browser.
const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(10 * 60);
/// How long the agent gets to print its sign-in link.
const LINK_TIMEOUT: Duration = Duration::from_secs(20);

fn failed(message: impl Into<String>) -> HarnessError {
    HarnessError::Probe(message.into())
}

/// A command of the CLI's own in the home folder, its output captured.
fn command(exe: &Path) -> Command {
    let mut cmd = cli::command(exe);
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    if let Some(home) = cli::home_dir() {
        cmd.current_dir(home);
    }
    cmd
}

/// How a command ended: its exit code and what it printed.
struct Output {
    code: Option<i32>,
    stdout: String,
    stderr: String,
}

impl Output {
    fn ok(&self) -> bool {
        self.code == Some(0)
    }

    /// The last few lines it printed, for an error.
    fn complaint(&self) -> String {
        let text = if self.stderr.trim().is_empty() { &self.stdout } else { &self.stderr };
        let lines: Vec<&str> = text.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
        lines[lines.len().saturating_sub(4)..].join("\n")
    }
}

async fn run(mut cmd: Command, timeout: Duration) -> Result<Output, HarnessError> {
    let child = cmd.kill_on_drop(true).spawn().map_err(|e| failed(e.to_string()))?;
    let out = tokio::time::timeout(timeout, child.wait_with_output())
        .await
        .map_err(|_| failed("Antigravity took too long to answer."))?
        .map_err(|e| failed(e.to_string()))?;
    Ok(Output {
        code: out.status.code(),
        stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
    })
}

/// `agy --version`.
async fn version(exe: &Path) -> Result<String, HarnessError> {
    let mut cmd = command(exe);
    cmd.arg("--version");
    let out = run(cmd, PROBE_TIMEOUT).await?;
    if !out.ok() {
        return Err(failed(out.complaint()));
    }
    parse_version(&out.stdout).ok_or_else(|| failed("agy didn't say its version."))
}

/// The first `x.y.z` in `text`.
fn parse_version(text: &str) -> Option<String> {
    text.split_whitespace()
        .map(|word| word.trim_start_matches('v'))
        .find(|word| numbers(word).is_some())
        .map(str::to_owned)
}

fn numbers(version: &str) -> Option<[u32; 3]> {
    let mut parts = version.split(['.', '-']);
    let mut out = [0; 3];
    for slot in &mut out {
        *slot = parts.next()?.parse().ok()?;
    }
    Some(out)
}

/// Whether `version` is at least [`MIN_VERSION`].
pub fn supported(version: &str) -> bool {
    numbers(version).is_some_and(|v| v >= MIN_VERSION)
}

fn too_old(version: &str) -> HarnessError {
    let [a, b, c] = MIN_VERSION;
    failed(format!("Outcode needs agy {a}.{b}.{c} or newer (this is {version}); update it."))
}

/// The binary and its version, refused when too old to ask safely.
async fn checked(binary: Option<&Path>) -> Result<std::path::PathBuf, HarnessError> {
    let exe = find(binary)?;
    let version = version(&exe).await?;
    if !supported(&version) {
        return Err(too_old(&version));
    }
    Ok(exe)
}

/// A read-only slash command in print mode, which starts no turn: its
/// `command.data`, or how it ended.
async fn slash(exe: &Path, name: &str) -> Result<Result<Value, Output>, HarnessError> {
    let mut cmd = command(exe);
    cmd.args(["-p", &format!("/{name}"), "--output-format", "json"]);
    let out = run(cmd, PROBE_TIMEOUT).await?;
    if !out.ok() {
        return Ok(Err(out));
    }
    let parsed: Value = serde_json::from_str(out.stdout.trim()).map_err(|_| failed(out.complaint()))?;
    // A turn would mean the command went to the model as a prompt.
    if parsed["command"]["name"].as_str() != Some(name) {
        return Err(failed(format!("agy didn't answer /{name} as a command.")));
    }
    Ok(Ok(parsed["command"]["data"].clone()))
}

/// What a failed command says about the login.
fn signed_out(out: &Output) -> bool {
    let text = format!("{}\n{}", out.stdout, out.stderr).to_lowercase();
    ["auth", "sign in", "sign-in", "log in", "login", "credential"]
        .iter()
        .any(|w| text.contains(w))
}

/// The installed CLI, its version and whether it's signed in.
pub async fn status(binary: Option<&Path>) -> ProviderStatus {
    let Ok(exe) = find(binary) else {
        return ProviderStatus::default();
    };
    let mut status = ProviderStatus {
        installed: true,
        path: Some(exe.display().to_string()),
        ..ProviderStatus::default()
    };
    let version = match version(&exe).await {
        Ok(version) => version,
        Err(e) => {
            status.error = Some(format!("Version check failed: {e}"));
            return status;
        }
    };
    status.version = Some(version.clone());
    if !supported(&version) {
        status.error = Some(too_old(&version).to_string());
        return status;
    }
    match slash(&exe, "credits").await {
        Ok(Ok(_)) => {
            status.account = Some(ProviderAccount {
                logged_in: true,
                method: Some("Google".into()),
                ..ProviderAccount::default()
            });
        }
        Ok(Err(out)) if signed_out(&out) => status.account = Some(ProviderAccount::default()),
        // An API key has no credits to show.
        Ok(Err(out)) if out.code == Some(2) => {
            status.account = Some(ProviderAccount {
                logged_in: true,
                method: Some("api-key".into()),
                ..ProviderAccount::default()
            });
        }
        Ok(Err(out)) => status.error = Some(format!("Login check failed: {}", out.complaint())),
        Err(e) => status.error = Some(format!("Login check failed: {e}")),
    }
    status
}

/// The plan's quota windows; `None` signed out or with an API key, which
/// have no account quota.
pub async fn usage(binary: Option<&Path>) -> Result<Option<Vec<UsageWindow>>, HarnessError> {
    let exe = checked(binary).await?;
    match slash(&exe, "usage").await? {
        Ok(data) => {
            let windows = usage_windows(&data);
            Ok((!windows.is_empty()).then_some(windows))
        }
        Err(out) if out.code == Some(2) || signed_out(&out) => Ok(None),
        Err(out) => Err(failed(out.complaint())),
    }
}

/// `/usage`'s groups of models, each with its windows.
fn usage_windows(data: &Value) -> Vec<UsageWindow> {
    let list = |v: &Value| v.as_array().cloned().unwrap_or_default();
    let mut windows = Vec::new();
    for group in list(&data["groups"]) {
        let scope = group_label(group["name"].as_str().unwrap_or_default());
        for bucket in list(&group["buckets"]) {
            let Some(remaining) = bucket["remaining_fraction"].as_f64() else {
                continue;
            };
            let span = match bucket["window"].as_str() {
                Some("weekly") => "Week".to_owned(),
                Some("daily") => "Day".to_owned(),
                Some("monthly") => "Month".to_owned(),
                Some(w) if w.ends_with('h') && w[..w.len() - 1].parse::<u32>().is_ok() => {
                    format!("{} hours", &w[..w.len() - 1])
                }
                _ => bucket["name"].as_str().unwrap_or("Limit").to_owned(),
            };
            windows.push(UsageWindow {
                label: if scope.is_empty() { span } else { format!("{span} · {scope}") },
                used: (1.0 - remaining).clamp(0.0, 1.0),
                // An untouched window reports the epoch.
                resets_at: bucket["reset_time"]
                    .as_str()
                    .filter(|t| !t.starts_with("1970-"))
                    .map(str::to_owned),
            });
        }
    }
    windows
}

/// "Gemini Models" → "Gemini", "Claude and GPT models" → "Claude & GPT".
fn group_label(name: &str) -> String {
    let name = name.trim();
    let name = name
        .strip_suffix(" models")
        .or_else(|| name.strip_suffix(" Models"))
        .unwrap_or(name);
    name.replace(" and ", " & ")
}

/// `agy update`.
pub async fn update(binary: Option<&Path>) -> Result<(), HarnessError> {
    let mut cmd = command(&find(binary)?);
    cmd.arg("update");
    let out = run(cmd, UPDATE_TIMEOUT).await?;
    if out.ok() { Ok(()) } else { Err(failed(out.complaint())) }
}

/// The newest release's manifest for this platform (`{ "version", … }`).
pub fn manifest_url() -> Option<String> {
    let os = match std::env::consts::OS {
        "windows" => "windows",
        "macos" => "darwin",
        "linux" => "linux",
        _ => return None,
    };
    let arch = match std::env::consts::ARCH {
        "x86_64" => "amd64",
        "aarch64" => "arm64",
        _ => return None,
    };
    Some(format!("{MANIFEST_BASE}/{os}_{arch}.json"))
}

/// Signs out over ACP (`logout`).
pub async fn sign_out(binary: Option<&Path>) -> Result<(), HarnessError> {
    let exe = checked(binary).await?;
    let server = tokio::time::timeout(PROBE_TIMEOUT, Server::start(&exe, cli::home_dir().as_deref()))
        .await
        .map_err(|_| failed("agy acp didn't start"))??;
    let Server { client, mut child, .. } = server;
    let answer = tokio::time::timeout(PROBE_TIMEOUT, client.request("logout", json!({})))
        .await
        .unwrap_or_else(|_| Err("Antigravity didn't sign out.".into()));
    drop(client);
    tokio::spawn(async move { retire(&mut child).await });
    answer.map(drop).map_err(failed)
}

/// A Google sign-in waiting on the browser. Dropping it stops the agent,
/// which ends the sign-in.
pub struct SignIn {
    server: Server,
    url: String,
    done: tokio::task::JoinHandle<Result<Value, String>>,
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
    /// The page that finishes it, should the browser not have opened.
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
            server: Server { client, mut child, .. },
            mut done,
            cancel,
            ..
        } = self;
        let outcome = tokio::select! {
            answer = &mut done => match answer {
                Ok(Ok(_)) => Ok(()),
                Ok(Err(e)) => Err(failed(e)),
                Err(_) => Err(failed("Antigravity stopped before the sign-in finished.")),
            },
            () = cancel.notified() => Err(failed("Sign-in cancelled.")),
            () = tokio::time::sleep(SIGN_IN_TIMEOUT) => Err(failed("The sign-in timed out.")),
        };
        done.abort();
        drop(client);
        cli::kill_tree(&mut child).await;
        outcome
    }
}

/// A Google sign-in link in what the agent printed.
fn sign_in_link(text: &str) -> Option<String> {
    let start = text.find("https://accounts.google.com")?;
    let link: String = text[start..].chars().take_while(|c| !c.is_whitespace()).collect();
    Some(link)
}

/// Starts Google's browser sign-in over ACP (`authenticate`): the agent
/// prints its link (and may open the browser itself); open
/// [`SignIn::url`], then [`SignIn::finish`].
pub async fn start_sign_in(binary: Option<&Path>) -> Result<SignIn, HarnessError> {
    let exe = checked(binary).await?;
    let mut server = tokio::time::timeout(PROBE_TIMEOUT, Server::start(&exe, cli::home_dir().as_deref()))
        .await
        .map_err(|_| failed("agy acp didn't start"))??;
    let authenticate = server
        .client
        .request("authenticate", json!({ "methodId": "oauth-personal" }));
    let mut done = tokio::spawn(authenticate);
    let deadline = tokio::time::sleep(LINK_TIMEOUT);
    tokio::pin!(deadline);
    let mut poll = tokio::time::interval(Duration::from_millis(200));
    let url = loop {
        tokio::select! {
            line = server.other.recv() => {
                if let Some(link) = line.as_deref().and_then(sign_in_link) {
                    break link;
                }
            }
            _ = poll.tick() => {
                if let Some(link) = sign_in_link(&server.stderr.text()) {
                    break link;
                }
            }
            answer = &mut done => {
                // Signed in already, or refused outright.
                let Server { client, mut child, .. } = server;
                drop(client);
                tokio::spawn(async move { retire(&mut child).await });
                return match answer {
                    Ok(Ok(_)) => Err(failed("Already signed in.")),
                    Ok(Err(e)) => Err(failed(e)),
                    Err(_) => Err(failed("Antigravity stopped before the sign-in started.")),
                };
            }
            () = &mut deadline => break INSTALL_URL.to_owned(),
        }
    };
    Ok(SignIn {
        server,
        url,
        done,
        cancel: Arc::new(Notify::new()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// As agy 1.5.18 answers `-p /usage --output-format json`.
    #[test]
    fn quota_buckets_become_windows() {
        let data = json!({ "groups": [
            { "name": "Gemini Models", "buckets": [
                { "id": "gemini-weekly", "window": "weekly", "remaining_fraction": 0.9636551737785339,
                  "reset_time": "2026-12-04T14:55:50Z" } ] },
            { "name": "Claude and GPT models", "buckets": [
                { "id": "3p-weekly", "window": "weekly", "remaining_fraction": 1, "reset_time": "1970-01-01T00:00:00Z" },
                { "id": "3p-5h", "window": "5h", "remaining_fraction": 0.25, "reset_time": "2026-11-27T20:00:00Z" } ] }
        ]});
        let windows = usage_windows(&data);
        assert_eq!(windows.len(), 3);
        assert_eq!(windows[0].label, "Week · Gemini");
        assert!((windows[0].used - 0.0363).abs() < 1e-3);
        assert_eq!(windows[0].resets_at.as_deref(), Some("2026-12-04T14:55:50Z"));
        assert_eq!(windows[1].label, "Week · Claude & GPT");
        assert_eq!(windows[1].used, 0.0);
        assert_eq!(windows[1].resets_at, None);
        assert_eq!(windows[2].label, "5 hours · Claude & GPT");
        assert!((windows[2].used - 0.75).abs() < 1e-9);
    }

    #[test]
    fn versions_gate_what_is_asked() {
        assert_eq!(parse_version("1.5.18\n").as_deref(), Some("1.5.18"));
        assert!(supported("1.5.18"));
        assert!(supported("1.5.1"));
        assert!(!supported("1.4.9"));
        assert!(!supported("nonsense"));
    }

    #[test]
    fn finds_the_sign_in_link() {
        let line = "Open the following link to authenticate the ACP server: https://accounts.google.com/o/oauth2/auth?x=1 ";
        assert_eq!(sign_in_link(line).as_deref(), Some("https://accounts.google.com/o/oauth2/auth?x=1"));
        assert_eq!(sign_in_link("nothing"), None);
    }

    /// Reads this machine's agy (no turns, no quota spent):
    /// `cargo test -p outcode-harness antigravity::provider -- --ignored --nocapture`.
    #[tokio::test]
    #[ignore = "needs agy installed and signed in"]
    async fn live_status_and_usage() {
        let status = status(None).await;
        println!("{status:?}");
        assert!(status.installed && status.version.is_some(), "{status:?}");
        assert!(status.account.as_ref().is_some_and(|a| a.logged_in), "{status:?}");
        let usage = usage(None).await.unwrap();
        println!("{usage:?}");
        assert!(usage.is_some_and(|w| !w.is_empty()));
    }
}
