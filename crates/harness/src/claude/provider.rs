//! Claude Code's CLI as a provider: its version and login (`claude
//! --version`, `claude auth status --json`), installing and updating it,
//! and signing in and out (`claude auth login` / `logout`).
//!
//! Sign-in runs the CLI's own flow ([`SignIn`]): the browser it opens
//! finishes the login through its localhost listener; the code a fallback
//! page shows can be pasted on stdin instead.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use outcode_proto::{ProviderAccount, ProviderStatus};
use serde_json::Value;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::process::{ChildStdin, Command};
use tokio::sync::Notify;

use super::{find, overrides};
use crate::HarnessError;

const PROBE_TIMEOUT: Duration = Duration::from_secs(15);
const UPDATE_TIMEOUT: Duration = Duration::from_secs(10 * 60);
/// How long the CLI gets to print the sign-in URL.
const SIGN_IN_START_TIMEOUT: Duration = Duration::from_secs(30);
/// How long a sign-in waits on the browser.
const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const CODE_PROMPT: &str = "Paste code here if prompted >";
const INVALID_CODE: &str = "That isn't the whole code. Copy all of it from the page and try again.";

fn failed(message: impl Into<String>) -> HarnessError {
    HarnessError::Probe(message.into())
}

/// A command of the CLI's own, its output captured.
fn cli(exe: &Path) -> Command {
    let mut cmd = overrides::command(exe);
    // Set when Outcode itself runs inside Claude Code.
    cmd.env_remove("CLAUDECODE")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    cmd
}

struct Output {
    success: bool,
    stdout: String,
    stderr: String,
}

impl Output {
    /// What it said went wrong.
    fn failure(&self) -> String {
        let text = if self.stderr.trim().is_empty() { &self.stdout } else { &self.stderr };
        tail(&strip_ansi(text))
    }
}

async fn run(mut cmd: Command, timeout: Duration) -> Result<Output, HarnessError> {
    let child = cmd.kill_on_drop(true).spawn().map_err(|e| failed(e.to_string()))?;
    let out = tokio::time::timeout(timeout, child.wait_with_output())
        .await
        .map_err(|_| failed("Claude took too long to answer."))?
        .map_err(|e| failed(e.to_string()))?;
    Ok(Output {
        success: out.status.success(),
        stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
    })
}

async fn run_ok(cmd: Command, timeout: Duration) -> Result<Output, HarnessError> {
    let out = run(cmd, timeout).await?;
    if out.success { Ok(out) } else { Err(failed(out.failure())) }
}

/// The installed CLI, its version and who is signed in. `binary` as for
/// [`find`].
pub async fn status(binary: Option<&Path>) -> ProviderStatus {
    let Ok(exe) = find(binary) else {
        return ProviderStatus::default();
    };
    let mut status = ProviderStatus {
        installed: true,
        path: Some(exe.display().to_string()),
        ..ProviderStatus::default()
    };
    let mut version = cli(&exe);
    version.arg("--version");
    let mut auth = cli(&exe);
    auth.args(["auth", "status", "--json"]);
    let (version, auth) = tokio::join!(run_ok(version, PROBE_TIMEOUT), run(auth, PROBE_TIMEOUT));

    let mut errors = Vec::new();
    match version {
        Ok(out) => status.version = parse_version(&out.stdout),
        Err(e) => errors.push(format!("Version check failed: {e}")),
    }
    // Signed out, it may exit non-zero but still print its JSON.
    match auth {
        Ok(out) => match parse_account(&out.stdout) {
            Some(account) => status.account = Some(account),
            None if out.success => errors.push("Couldn't read the login status.".into()),
            None => errors.push(format!("Login check failed: {}", out.failure())),
        },
        Err(e) => errors.push(format!("Login check failed: {e}")),
    }
    if !errors.is_empty() {
        status.error = Some(errors.join(" "));
    }
    status
}

/// The installed CLI's version (`2.1.332`), for the usage endpoint's agent.
pub async fn version(binary: Option<&Path>) -> Option<String> {
    let mut cmd = cli(&find(binary).ok()?);
    cmd.arg("--version");
    parse_version(&run_ok(cmd, PROBE_TIMEOUT).await.ok()?.stdout)
}

/// The first `x.y.z` in `text`.
fn parse_version(text: &str) -> Option<String> {
    text.split(|c: char| c.is_whitespace() || c == '(' || c == ')')
        .map(|word| word.trim_start_matches('v'))
        .find(|word| {
            let parts: Vec<&str> = word.split('.').collect();
            parts.len() >= 3 && parts.iter().take(3).all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()))
        })
        .map(str::to_owned)
}

fn parse_account(text: &str) -> Option<ProviderAccount> {
    let start = text.find('{')?;
    let json: Value = serde_json::from_str(text[start..].trim()).ok()?;
    let field = |key: &str| {
        json.get(key)
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
    };
    Some(ProviderAccount {
        logged_in: json.get("loggedIn")?.as_bool()?,
        method: field("authMethod"),
        email: field("email"),
        organization: field("orgName"),
        plan: field("subscriptionType"),
    })
}

/// The CLI's subscription login token, read (never refreshed: the CLI holds
/// the single-use refresh token), when it has one that hasn't expired.
/// `Ok(None)`: no subscription login to ask about (signed out, an API key).
pub async fn oauth_token() -> Result<Option<String>, HarnessError> {
    let Some(path) = overrides::config_dir().map(|d| d.join(".credentials.json")) else {
        return Ok(None);
    };
    let Ok(text) = tokio::fs::read_to_string(path).await else {
        return Ok(None);
    };
    let json: Value = serde_json::from_str(&text).map_err(|_| failed("Claude's login file is unreadable."))?;
    let Some(oauth) = json.get("claudeAiOauth") else {
        return Ok(None);
    };
    let Some(token) = oauth.get("accessToken").and_then(Value::as_str) else {
        return Ok(None);
    };
    // Some CLI versions wrote 0 for fresh logins: only a real past time counts.
    let expires = oauth.get("expiresAt").and_then(Value::as_u64).unwrap_or(0);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64);
    if expires > 0 && expires < now {
        return Err(failed("The login has expired; Claude renews it on its next turn."));
    }
    Ok(Some(token.to_owned()))
}

/// `claude update`: installs the newest release, through the package
/// manager when one installed it.
pub async fn update(binary: Option<&Path>) -> Result<(), HarnessError> {
    let mut cmd = cli(&find(binary)?);
    cmd.arg("update");
    run_ok(cmd, UPDATE_TIMEOUT).await.map(drop)
}

/// Runs Anthropic's installer for this platform.
pub async fn install() -> Result<(), HarnessError> {
    let mut cmd = if cfg!(windows) {
        let mut cmd = crate::cli::command(Path::new("powershell"));
        cmd.args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "irm https://claude.ai/install.ps1 | iex"]);
        cmd
    } else {
        let mut cmd = crate::cli::command(Path::new("bash"));
        cmd.args(["-c", "curl -fsSL https://claude.ai/install.sh | bash"]);
        cmd
    };
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    run_ok(cmd, UPDATE_TIMEOUT).await?;
    if find(None).is_err() {
        return Err(failed(
            "The installer finished, but `claude` wasn't found. Add ~/.local/bin to PATH and restart Outcode.",
        ));
    }
    Ok(())
}

pub async fn sign_out(binary: Option<&Path>) -> Result<(), HarnessError> {
    let mut cmd = cli(&find(binary)?);
    cmd.args(["auth", "logout"]);
    run_ok(cmd, PROBE_TIMEOUT).await.map(drop)
}

/// A running `claude auth login`. Dropping it ends the login.
///
/// As in a terminal, the CLI opens the browser itself on a page that
/// redirects to its own localhost listener: approving there finishes the
/// login. The URL it prints is the fallback for when the browser didn't
/// open: that page shows a code, which goes in on stdin ([`SignIn::submit`]).
pub struct SignIn {
    child: tokio::process::Child,
    stdin: Arc<tokio::sync::Mutex<ChildStdin>>,
    output: Arc<Mutex<String>>,
    url: String,
    cancel: Arc<Notify>,
}

/// What answers a sign-in in progress while [`SignIn::finish`] waits.
#[derive(Clone)]
pub struct SignInControl {
    stdin: Arc<tokio::sync::Mutex<ChildStdin>>,
    output: Arc<Mutex<String>>,
    cancel: Arc<Notify>,
}

impl SignIn {
    /// The fallback page, showing a code.
    pub fn url(&self) -> &str {
        &self.url
    }

    pub fn control(&self) -> SignInControl {
        SignInControl {
            stdin: Arc::clone(&self.stdin),
            output: Arc::clone(&self.output),
            cancel: Arc::clone(&self.cancel),
        }
    }

    /// Waits for the CLI to finish logging in: through the browser, or a
    /// code pasted meanwhile.
    pub async fn finish(mut self) -> Result<(), HarnessError> {
        let status = tokio::select! {
            status = self.child.wait() => status.map_err(|e| failed(e.to_string()))?,
            _ = self.cancel.notified() => return Err(failed("Sign-in cancelled.")),
            _ = tokio::time::sleep(SIGN_IN_TIMEOUT) => return Err(failed("Sign-in timed out.")),
        };
        // Let the readers drain what it printed.
        tokio::time::sleep(Duration::from_millis(50)).await;
        if status.success() {
            return Ok(());
        }
        let output = lock(&self.output).clone();
        let after = output.rsplit_once(CODE_PROMPT).map_or(output.as_str(), |(_, rest)| rest);
        let message = tail(&strip_ansi(after));
        Err(failed(if message.is_empty() { "Sign-in failed. Try again.".into() } else { message }))
    }
}

impl SignInControl {
    /// Pastes the fallback page's `code` (`code#state`). The CLI exchanges
    /// it and exits, which ends [`SignIn::finish`]; one it can't read is
    /// refused here and it keeps waiting.
    pub async fn submit(&self, code: &str) -> Result<(), HarnessError> {
        let code = code.trim();
        if code.split_once('#').is_none_or(|(c, s)| c.is_empty() || s.is_empty()) {
            return Err(failed(INVALID_CODE));
        }
        let seen = lock(&self.output).len();
        let mut stdin = self.stdin.lock().await;
        stdin
            .write_all(format!("{code}\n").as_bytes())
            .await
            .map_err(|_| failed("This sign-in has ended. Start again."))?;
        let _ = stdin.flush().await;
        drop(stdin);
        // It answers a malformed one at once, and keeps waiting.
        tokio::time::sleep(Duration::from_millis(300)).await;
        if lock(&self.output).get(seen..).is_some_and(|new| new.contains("Invalid code")) {
            return Err(failed(INVALID_CODE));
        }
        Ok(())
    }

    pub fn cancel(&self) {
        self.cancel.notify_one();
    }
}

/// Starts `claude auth login`; resolves once it has printed its sign-in page.
pub async fn start_sign_in(binary: Option<&Path>) -> Result<SignIn, HarnessError> {
    let mut cmd = cli(&find(binary)?);
    cmd.args(["auth", "login"]).stdin(Stdio::piped()).kill_on_drop(true);
    let mut child = cmd.spawn().map_err(|e| failed(e.to_string()))?;
    let stdin = child.stdin.take().expect("piped stdin");
    let output = Arc::new(Mutex::new(String::new()));
    tokio::spawn(collect(child.stdout.take().expect("piped stdout"), Arc::clone(&output)));
    tokio::spawn(collect(child.stderr.take().expect("piped stderr"), Arc::clone(&output)));

    let deadline = tokio::time::Instant::now() + SIGN_IN_START_TIMEOUT;
    loop {
        let url = sign_in_url(&lock(&output));
        if let Some(url) = url {
            return Ok(SignIn {
                child,
                stdin: Arc::new(tokio::sync::Mutex::new(stdin)),
                output,
                url,
                cancel: Arc::new(Notify::new()),
            });
        }
        if let Ok(Some(_)) = child.try_wait() {
            tokio::time::sleep(Duration::from_millis(50)).await;
            let message = tail(&strip_ansi(&lock(&output)));
            return Err(failed(if message.is_empty() {
                "claude auth login exited before showing a sign-in link.".into()
            } else {
                message
            }));
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(failed("Claude didn't show a sign-in link."));
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

async fn collect(mut reader: impl AsyncRead + Unpin, output: Arc<Mutex<String>>) {
    let mut buf = [0u8; 4096];
    while let Ok(n) = reader.read(&mut buf).await {
        if n == 0 {
            break;
        }
        lock(&output).push_str(&String::from_utf8_lossy(&buf[..n]));
    }
}

/// The first complete `https://` URL printed: one followed by whitespace, so
/// a URL still arriving isn't taken half-written.
fn sign_in_url(output: &str) -> Option<String> {
    let text = strip_ansi(output);
    let start = text.find("https://")?;
    let rest = &text[start..];
    let end = rest.find(char::is_whitespace)?;
    Some(rest[..end].to_owned())
}

fn lock(output: &Mutex<String>) -> std::sync::MutexGuard<'_, String> {
    output.lock().unwrap_or_else(|e| e.into_inner())
}

/// `text` without terminal escape sequences.
fn strip_ansi(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            if chars.peek() == Some(&'[') {
                chars.next();
                // Parameters, then one final byte in @–~.
                for c in chars.by_ref() {
                    if ('@'..='~').contains(&c) {
                        break;
                    }
                }
            } else {
                chars.next();
            }
            continue;
        }
        out.push(c);
    }
    out
}

/// The last few non-blank lines, for an error message.
fn tail(text: &str) -> String {
    let lines: Vec<&str> = text.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    lines[lines.len().saturating_sub(4)..].join("\n")
}

/// Where the CLI keeps its settings and login (`CLAUDE_CONFIG_DIR`, else `~/.claude`).
pub fn config_dir() -> Option<PathBuf> {
    overrides::config_dir()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_account() {
        let account = parse_account(
            r#"{"loggedIn": true, "authMethod": "claude.ai", "email": "a@b.c",
                "orgName": "Org", "subscriptionType": "max"}"#,
        )
        .unwrap();
        assert!(account.logged_in);
        assert_eq!(account.email.as_deref(), Some("a@b.c"));
        assert_eq!(account.plan.as_deref(), Some("max"));
        assert!(!parse_account(r#"{"loggedIn": false}"#).unwrap().logged_in);
        assert!(parse_account("not json").is_none());
    }

    #[test]
    fn versions_and_urls_parse() {
        assert_eq!(parse_version("2.1.332 (Claude Code)").as_deref(), Some("2.1.332"));
        assert_eq!(parse_version("nothing"), None);
        let printed = "If the browser didn't open, visit: \u{1b}[1mhttps://claude.com/oauth?x=1";
        assert_eq!(sign_in_url(printed), None);
        let printed = format!("{printed}\u{1b}[0m\n{CODE_PROMPT} ");
        assert_eq!(sign_in_url(&printed).as_deref(), Some("https://claude.com/oauth?x=1"));
    }
}
