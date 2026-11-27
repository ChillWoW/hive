//! Antigravity's CLI as a provider: its version (`agy --version`), whether
//! it's signed in (ACP `session/list`), the plan's quota (print mode's
//! `/usage`, which answers without starting a turn or spending quota),
//! updating it (`agy update`), signing in (`agy acp --login`: a Google link,
//! then the code its page shows, pasted back) and out (ACP `logout`).
//!
//! ⚠ Signed out, print mode starts Google's sign-in in the browser by
//! itself, so `/usage` only runs once ACP says the CLI is signed in; ACP
//! just answers "Authentication required".
//!
//! ⚠ Before 1.1.11 print mode sent a slash command to the model as a prompt,
//! so nothing is asked of a CLI older than [`MIN_VERSION`].

use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use outcode_proto::{ProviderAccount, ProviderStatus, UsageWindow};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{Mutex as AsyncMutex, Notify};

use super::acp::{Server, retire};
use super::find;
use crate::{HarnessError, cli};

/// What ACP answers a signed-out CLI.
pub(super) const SIGNED_OUT: &str = "Authentication required";

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

/// Whether the CLI is signed in, asked over ACP (`session/list`), which
/// neither starts a sign-in nor leaves a conversation behind.
pub(super) async fn signed_in(exe: &Path) -> Result<bool, HarnessError> {
    let server = tokio::time::timeout(PROBE_TIMEOUT, Server::start(exe, cli::home_dir().as_deref()))
        .await
        .map_err(|_| failed("agy acp didn't start"))??;
    let Server { client, mut child, .. } = server;
    let answer = tokio::time::timeout(PROBE_TIMEOUT, client.request("session/list", json!({})))
        .await
        .unwrap_or_else(|_| Err("agy didn't answer session/list".into()));
    drop(client);
    tokio::spawn(async move { retire(&mut child).await });
    match answer {
        Ok(_) => Ok(true),
        Err(e) if e.contains(SIGNED_OUT) => Ok(false),
        Err(e) => Err(failed(e)),
    }
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
    match signed_in(&exe).await {
        Ok(logged_in) => {
            status.account = Some(ProviderAccount {
                logged_in,
                method: logged_in.then(|| "Google".into()),
                ..ProviderAccount::default()
            });
        }
        Err(e) => status.error = Some(format!("Login check failed: {e}")),
    }
    status
}

/// The plan's quota windows; `None` signed out or with an API key, which
/// have no account quota.
pub async fn usage(binary: Option<&Path>) -> Result<Option<Vec<UsageWindow>>, HarnessError> {
    let exe = checked(binary).await?;
    if !signed_in(&exe).await? {
        return Ok(None);
    }
    match slash(&exe, "usage").await? {
        Ok(data) => {
            let windows = usage_windows(&data);
            Ok((!windows.is_empty()).then_some(windows))
        }
        // An API key has no account quota to show.
        Err(out) if out.code == Some(2) => Ok(None),
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

/// A Google sign-in through `agy acp --login`, waiting for the code the
/// Antigravity page shows. Dropping it stops the CLI, which ends the sign-in.
pub struct SignIn {
    child: Child,
    url: String,
    control: SignInControl,
    /// The end of what it printed, for an error.
    printed: Arc<std::sync::Mutex<String>>,
}

/// Answers or cancels a [`SignIn`] from elsewhere; cheap to clone.
#[derive(Clone)]
pub struct SignInControl {
    cancel: Arc<Notify>,
    stdin: Arc<AsyncMutex<Option<ChildStdin>>>,
}

impl SignInControl {
    pub fn cancel(&self) {
        self.cancel.notify_one();
    }

    /// Hands the CLI the code from the Antigravity page (or that page's
    /// full URL).
    pub async fn submit(&self, code: &str) -> Result<(), HarnessError> {
        let code = login_response(code).ok_or_else(|| failed("Paste the code from the Antigravity page, or its full URL."))?;
        let mut stdin = self.stdin.lock().await;
        let Some(pipe) = stdin.as_mut() else {
            return Err(failed("No sign-in is waiting for a code."));
        };
        let line = format!("{code}\n");
        if pipe.write_all(line.as_bytes()).await.is_err() || pipe.flush().await.is_err() {
            *stdin = None;
            return Err(failed("Antigravity stopped before the code arrived."));
        }
        Ok(())
    }
}

/// What `--login` reads: one line, no spaces in it.
fn login_response(code: &str) -> Option<&str> {
    let code = code.trim();
    (!code.is_empty() && code.len() <= 16 * 1024 && !code.chars().any(char::is_whitespace)).then_some(code)
}

impl SignIn {
    /// The Google page to sign in on.
    pub fn url(&self) -> &str {
        &self.url
    }

    pub fn control(&self) -> SignInControl {
        self.control.clone()
    }

    /// Waits for the CLI to take the code and exit, a cancel, or
    /// [`SIGN_IN_TIMEOUT`].
    pub async fn finish(mut self) -> Result<(), HarnessError> {
        let outcome = tokio::select! {
            status = self.child.wait() => match status {
                Ok(status) if status.success() => Ok(()),
                Ok(_) => {
                    let printed = self.printed.lock().unwrap().clone();
                    let last = printed.lines().map(str::trim).rfind(|l| !l.is_empty()).unwrap_or_default().to_owned();
                    Err(failed(if last.is_empty() {
                        "Antigravity couldn't finish the sign-in. Start it again.".to_owned()
                    } else {
                        format!("Antigravity couldn't finish the sign-in: {last}")
                    }))
                }
                Err(e) => Err(failed(e.to_string())),
            },
            () = self.control.cancel.notified() => Err(failed("Sign-in cancelled.")),
            () = tokio::time::sleep(SIGN_IN_TIMEOUT) => Err(failed("The sign-in timed out.")),
        };
        self.control.stdin.lock().await.take();
        if outcome.is_err() {
            cli::kill_tree(&mut self.child).await;
        }
        outcome
    }
}

/// A Google sign-in link in what the CLI printed.
fn sign_in_link(text: &str) -> Option<String> {
    let start = text.find("https://accounts.google.com/")?;
    let link: String = text[start..].chars().take_while(|c| !c.is_whitespace()).collect();
    Some(link)
}

/// Starts Google's sign-in with `agy acp --login`, which prints a link and
/// waits for the code the Antigravity page shows: open [`SignIn::url`],
/// [`SignInControl::submit`] the code, then [`SignIn::finish`].
pub async fn start_sign_in(binary: Option<&Path>) -> Result<SignIn, HarnessError> {
    let exe = checked(binary).await?;
    let mut cmd = cli::command(&exe);
    cmd.args(["acp", "--login"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(home) = cli::home_dir() {
        cmd.current_dir(home);
    }
    let mut child = cmd.spawn().map_err(|e| HarnessError::Spawn(super::NAME, e))?;
    let stdin = child.stdin.take().expect("piped stdin");
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = cli::StderrTail::collect(child.stderr.take().expect("piped stderr"));

    // Everything it prints is kept; the link goes out as soon as it shows.
    let printed = Arc::new(std::sync::Mutex::new(String::new()));
    let (link_tx, link_rx) = tokio::sync::oneshot::channel();
    let kept = Arc::clone(&printed);
    tokio::spawn(async move {
        let mut link_tx = Some(link_tx);
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if let Some(link) = sign_in_link(&line)
                && let Some(tx) = link_tx.take()
            {
                let _ = tx.send(link);
            }
            let mut kept = kept.lock().unwrap();
            kept.push_str(&line);
            kept.push('\n');
            if kept.len() > 8 * 1024 {
                let cut = kept.len() - 8 * 1024;
                let cut = (cut..kept.len()).find(|i| kept.is_char_boundary(*i)).unwrap_or(0);
                kept.drain(..cut);
            }
        }
    });
    let url = match tokio::time::timeout(LINK_TIMEOUT, link_rx).await {
        Ok(Ok(url)) => url,
        _ => {
            cli::kill_tree(&mut child).await;
            let said = printed.lock().unwrap().clone();
            return Err(failed(stderr.under(format!(
                "Antigravity didn't give a sign-in link.{}",
                if said.trim().is_empty() { String::new() } else { format!("\n{}", said.trim()) }
            ))));
        }
    };
    Ok(SignIn {
        child,
        url,
        control: SignInControl {
            cancel: Arc::new(Notify::new()),
            stdin: Arc::new(AsyncMutex::new(Some(stdin))),
        },
        printed,
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
    fn finds_the_sign_in_link_and_takes_one_line_codes() {
        // As `agy acp --login` 1.5.18 prints it.
        let line = "  https://accounts.google.com/o/oauth2/auth?access_type=offline&state=x ";
        assert_eq!(
            sign_in_link(line).as_deref(),
            Some("https://accounts.google.com/o/oauth2/auth?access_type=offline&state=x")
        );
        assert_eq!(sign_in_link("Then paste the authorization code"), None);
        assert_eq!(login_response("  4/0AUn6Hd-abc_DEF \n"), Some("4/0AUn6Hd-abc_DEF"));
        assert_eq!(
            login_response("https://antigravity.google/oauth-callback?code=4/0A&state=x"),
            Some("https://antigravity.google/oauth-callback?code=4/0A&state=x")
        );
        assert_eq!(login_response("two words"), None);
        assert_eq!(login_response("a\nb"), None);
        assert_eq!(login_response("   "), None);
    }

    /// Reads this machine's agy (no turns, no quota spent, and signed out
    /// no sign-in starts): `cargo test -p outcode-harness antigravity::provider::tests::live_status -- --ignored --nocapture`.
    #[tokio::test]
    #[ignore = "needs agy installed"]
    async fn live_status_and_usage() {
        let status = status(None).await;
        println!("{status:?}");
        assert!(status.installed && status.version.is_some(), "{status:?}");
        assert!(status.error.is_none(), "{status:?}");
        let signed_in = status.account.as_ref().is_some_and(|a| a.logged_in);
        let usage = usage(None).await.unwrap();
        println!("{usage:?}");
        assert_eq!(usage.is_some_and(|w| !w.is_empty()), signed_in);
    }

    /// Signs in for real: prints the link, then waits for the code to be
    /// written to `$OUTCODE_AGY_CODE_FILE`.
    #[tokio::test]
    #[ignore = "needs a person to open the link and paste the code"]
    async fn live_sign_in() {
        let file = std::path::PathBuf::from(std::env::var("OUTCODE_AGY_CODE_FILE").expect("OUTCODE_AGY_CODE_FILE"));
        let _ = std::fs::remove_file(&file);
        let sign_in = start_sign_in(None).await.unwrap();
        println!("LINK {}", sign_in.url());
        let control = sign_in.control();
        tokio::spawn(async move {
            loop {
                if let Ok(code) = std::fs::read_to_string(&file) {
                    println!("submitting the code: {:?}", control.submit(&code).await);
                    return;
                }
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
        });
        sign_in.finish().await.unwrap();
        assert!(signed_in(&find(None).unwrap()).await.unwrap());
        println!("signed in");
    }

    /// Signs out for real; sign in again afterwards.
    #[tokio::test]
    #[ignore = "signs this machine's agy out"]
    async fn live_sign_out() {
        sign_out(None).await.unwrap();
        assert!(!signed_in(&find(None).unwrap()).await.unwrap());
        assert_eq!(usage(None).await.unwrap(), None);
        println!("signed out");
    }
}
