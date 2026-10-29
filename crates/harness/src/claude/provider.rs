//! Claude Code's CLI as a provider: its version and login (`claude --version`,
//! `claude auth status`), installing it, updating it (`claude update`), and
//! signing in and out (`claude auth login` / `logout`).
//!
//! Sign-in runs the CLI's own flow. Without a terminal, `claude auth login`
//! opens the browser, prints the page's URL and waits for the code that page
//! shows to be pasted on stdin.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use hive_proto::{HarnessId, ProviderAccount, ProviderStatus, SignInMethod};
use serde_json::Value;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, ChildStdin, Command};

use super::{command_for, find_claude};
use crate::provider::ProviderError;

const PROBE_TIMEOUT: Duration = Duration::from_secs(15);
const INSTALL_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const UPDATE_TIMEOUT: Duration = Duration::from_secs(10 * 60);
/// How long the CLI gets to print the sign-in URL.
const SIGN_IN_START_TIMEOUT: Duration = Duration::from_secs(30);
/// How long it gets to trade a pasted code for a login.
const SIGN_IN_FINISH_TIMEOUT: Duration = Duration::from_secs(60);

pub(super) fn cli(exe: &Path) -> Command {
    let mut cmd = command_for(exe);
    // Set when Hive itself runs inside Claude Code.
    cmd.env_remove("CLAUDECODE")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    no_window(&mut cmd);
    cmd
}

fn no_window(cmd: &mut Command) {
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    #[cfg(not(windows))]
    let _ = cmd;
}

fn installed() -> Result<PathBuf, ProviderError> {
    find_claude().ok_or(ProviderError::NotInstalled("claude"))
}

pub(super) struct Output {
    pub(super) success: bool,
    pub(super) stdout: String,
    stderr: String,
}

impl Output {
    /// What to show when it failed: the last lines it printed.
    fn failure(&self) -> ProviderError {
        let text = if self.stderr.trim().is_empty() {
            &self.stdout
        } else {
            &self.stderr
        };
        ProviderError::Failed(tail(&strip_ansi(text)))
    }
}

pub(super) async fn run(mut cmd: Command, timeout: Duration) -> Result<Output, ProviderError> {
    let child = cmd.spawn().map_err(|e| ProviderError::Failed(e.to_string()))?;
    match tokio::time::timeout(timeout, child.wait_with_output()).await {
        Ok(Ok(out)) => Ok(Output {
            success: out.status.success(),
            stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
        }),
        Ok(Err(e)) => Err(ProviderError::Failed(e.to_string())),
        // Dropping the future kills the child (`kill_on_drop`).
        Err(_) => Err(ProviderError::TimedOut),
    }
}

pub async fn status() -> ProviderStatus {
    let mut status = ProviderStatus {
        harness: HarnessId::ClaudeCode,
        installed: false,
        path: None,
        version: None,
        update_channel: None,
        account: None,
        error: None,
        can_install: true,
        can_update: false,
        can_sign_in: false,
    };
    let Some(exe) = find_claude() else {
        return status;
    };
    status.installed = true;
    status.path = Some(exe.display().to_string());
    status.can_update = true;
    status.can_sign_in = true;
    status.update_channel = Some(update_channel());

    let mut version = cli(&exe);
    version.arg("--version");
    let mut auth = cli(&exe);
    auth.args(["auth", "status", "--json"]);
    let (version, auth) = tokio::join!(run(version, PROBE_TIMEOUT), run(auth, PROBE_TIMEOUT));

    let mut errors = Vec::new();
    match version {
        Ok(out) if out.success => status.version = parse_version(&out.stdout),
        Ok(out) => errors.push(format!("version check failed: {}", out.failure())),
        Err(e) => errors.push(format!("version check failed: {e}")),
    }
    // Signed out, it may exit non-zero but still print its JSON.
    match auth {
        Ok(out) => match parse_account(&out.stdout) {
            Some(account) => status.account = Some(account),
            None if out.success => errors.push("couldn't read the login status".into()),
            None => errors.push(format!("login check failed: {}", out.failure())),
        },
        Err(e) => errors.push(format!("login check failed: {e}")),
    }
    if !errors.is_empty() {
        status.error = Some(errors.join("; "));
    }
    status
}

/// `"2.1.312 (Claude Code)"` → `"2.1.312"`.
pub(super) fn parse_version(text: &str) -> Option<String> {
    text.split_whitespace()
        .find(|word| word.starts_with(|c: char| c.is_ascii_digit()) && word.contains('.'))
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

pub(super) fn config_dir() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("CLAUDE_CONFIG_DIR") {
        return Some(dir.into());
    }
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })?;
    Some(PathBuf::from(home).join(".claude"))
}

/// `autoUpdatesChannel` from the user's Claude settings; `latest` unless set.
fn update_channel() -> String {
    config_dir()
        .and_then(|dir| std::fs::read_to_string(dir.join("settings.json")).ok())
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|json| json.get("autoUpdatesChannel")?.as_str().map(str::to_owned))
        .filter(|channel| !channel.is_empty())
        .unwrap_or_else(|| "latest".into())
}

/// Runs Anthropic's installer for this platform.
pub async fn install() -> Result<(), ProviderError> {
    let mut cmd = if cfg!(windows) {
        let mut cmd = Command::new("powershell.exe");
        cmd.args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            "irm https://claude.ai/install.ps1 | iex",
        ]);
        cmd
    } else {
        let mut cmd = Command::new("/bin/bash");
        cmd.args(["-c", "curl -fsSL https://claude.ai/install.sh | bash"]);
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
            "The installer finished, but `claude` wasn't found. Add ~/.local/bin to PATH \
             and restart Hive."
                .into(),
        )
    })
}

/// `claude update`: installs the newest release of its channel, through the
/// package manager when one installed it.
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
    cmd.args(["auth", "logout"]);
    let out = run(cmd, PROBE_TIMEOUT).await?;
    if out.success {
        Ok(())
    } else {
        Err(out.failure())
    }
}

/// A `claude auth login` waiting for its code. Dropping it ends the login.
pub struct SignIn {
    child: Child,
    stdin: ChildStdin,
    output: Arc<Mutex<String>>,
    url: String,
}

impl SignIn {
    pub fn url(&self) -> &str {
        &self.url
    }

    /// Pastes `code` and waits for the CLI to finish logging in.
    pub async fn finish(mut self, code: &str) -> Result<(), ProviderError> {
        let line = format!("{}\n", code.trim());
        self.stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|e| ProviderError::Failed(e.to_string()))?;
        let _ = self.stdin.flush().await;
        let status = tokio::time::timeout(SIGN_IN_FINISH_TIMEOUT, self.child.wait())
            .await
            .map_err(|_| ProviderError::TimedOut)?
            .map_err(|e| ProviderError::Failed(e.to_string()))?;
        if status.success() {
            return Ok(());
        }
        // The output since the code went in, where the CLI says what failed.
        let output = lock(&self.output).clone();
        let after = output.rsplit_once('>').map_or(output.as_str(), |(_, rest)| rest);
        let message = tail(&strip_ansi(after));
        Err(ProviderError::Failed(if message.is_empty() {
            "Sign-in failed. Check the code and try again.".into()
        } else {
            message
        }))
    }
}

pub async fn start_sign_in(method: SignInMethod) -> Result<SignIn, ProviderError> {
    let mut cmd = command_for(&installed()?);
    cmd.args(["auth", "login"]);
    if method == SignInMethod::Console {
        cmd.arg("--console");
    }
    cmd.env_remove("CLAUDECODE")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    no_window(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| ProviderError::Failed(e.to_string()))?;
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
                stdin,
                output,
                url,
            });
        }
        if let Ok(Some(_)) = child.try_wait() {
            // Let the readers drain what it printed before exiting.
            tokio::time::sleep(Duration::from_millis(50)).await;
            let message = tail(&strip_ansi(&lock(&output)));
            return Err(ProviderError::Failed(if message.is_empty() {
                "claude auth login exited before showing a sign-in link".into()
            } else {
                message
            }));
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(ProviderError::TimedOut);
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

/// Drops terminal escape sequences (colours, cursor moves).
fn strip_ansi(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\u{1b}' {
            out.push(c);
            continue;
        }
        if chars.peek() == Some(&'[') {
            chars.next();
            // Parameters, then one final byte in @..~.
            for c in chars.by_ref() {
                if ('@'..='~').contains(&c) {
                    break;
                }
            }
        } else {
            chars.next();
        }
    }
    out
}

/// The last few non-empty lines, for an error message.
fn tail(text: &str) -> String {
    let lines: Vec<&str> = text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect();
    lines[lines.len().saturating_sub(3)..].join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_version() {
        assert_eq!(
            parse_version("2.1.312 (Claude Code)\n").as_deref(),
            Some("2.1.312")
        );
        assert_eq!(parse_version("Claude Code\n"), None);
    }

    #[test]
    fn reads_the_account() {
        let account = parse_account(
            r#"{"loggedIn": true, "authMethod": "claude.ai", "email": "a@b.c",
                "orgName": "Org", "subscriptionType": "max"}"#,
        )
        .unwrap();
        assert!(account.logged_in);
        assert_eq!(account.method.as_deref(), Some("claude.ai"));
        assert_eq!(account.email.as_deref(), Some("a@b.c"));
        assert_eq!(account.plan.as_deref(), Some("max"));

        let out = parse_account(r#"{"loggedIn": false}"#).unwrap();
        assert!(!out.logged_in && out.email.is_none());
        assert!(parse_account("not json").is_none());
    }

    #[test]
    fn finds_the_sign_in_url_once_complete() {
        let printed = "Opening browser to sign in…\nIf the browser didn't open, visit: \
                       \u{1b}[1mhttps://claude.com/cai/oauth/authorize?code=true&x=1";
        assert_eq!(sign_in_url(printed), None);
        let printed = format!("{printed}\u{1b}[0m\nPaste code here if prompted > ");
        assert_eq!(
            sign_in_url(&printed).as_deref(),
            Some("https://claude.com/cai/oauth/authorize?code=true&x=1")
        );
    }

    #[test]
    fn strips_escapes() {
        assert_eq!(strip_ansi("\u{1b}[31merror\u{1b}[0m: bad"), "error: bad");
    }
}
