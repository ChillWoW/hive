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

use super::find_claude;
use crate::cli;
use crate::provider::{
    self, captured, parse_version, run, run_ok, strip_ansi, tail, ProviderError, UPDATE_TIMEOUT,
};

const PROBE_TIMEOUT: Duration = Duration::from_secs(15);
/// How long the CLI gets to print the sign-in URL.
const SIGN_IN_START_TIMEOUT: Duration = Duration::from_secs(30);
/// How long it gets to trade a pasted code for a login.
const SIGN_IN_FINISH_TIMEOUT: Duration = Duration::from_secs(60);

pub(super) fn cli(exe: &Path) -> Command {
    let mut cmd = cli::command(exe);
    // Set when Hive itself runs inside Claude Code.
    cmd.env_remove("CLAUDECODE");
    captured(cmd)
}

fn installed() -> Result<PathBuf, ProviderError> {
    find_claude().ok_or(ProviderError::NotInstalled("claude"))
}

pub async fn status() -> ProviderStatus {
    let exe = find_claude();
    let mut status = provider::found(HarnessId::ClaudeCode, exe.as_deref());
    let Some(exe) = exe else {
        return status;
    };
    status.can_sign_in = true;
    status.update_channel = Some(update_channel());

    let mut version = cli(&exe);
    version.arg("--version");
    let mut auth = cli(&exe);
    auth.args(["auth", "status", "--json"]);
    let (version, auth) = tokio::join!(run_ok(version, PROBE_TIMEOUT), run(auth, PROBE_TIMEOUT));

    let mut errors = Vec::new();
    match version {
        Ok(out) => status.version = parse_version(&out.stdout),
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
    Some(cli::home_dir()?.join(".claude"))
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
    let cmd = provider::install_script(
        "https://claude.ai/install.ps1",
        "https://claude.ai/install.sh",
        "bash",
    );
    provider::run_installer(
        cmd,
        || installed().is_ok(),
        "The installer finished, but `claude` wasn't found. Add ~/.local/bin to PATH and \
         restart Hive.",
    )
    .await
}

/// `claude update`: installs the newest release of its channel, through the
/// package manager when one installed it.
pub async fn update() -> Result<(), ProviderError> {
    let mut cmd = cli(&installed()?);
    cmd.arg("update");
    run_ok(cmd, UPDATE_TIMEOUT).await.map(drop)
}

pub async fn sign_out() -> Result<(), ProviderError> {
    let mut cmd = cli(&installed()?);
    cmd.args(["auth", "logout"]);
    run_ok(cmd, PROBE_TIMEOUT).await.map(drop)
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
    let mut cmd = cli(&installed()?);
    cmd.args(["auth", "login"]);
    if method == SignInMethod::Console {
        cmd.arg("--console");
    }
    // The code goes in on stdin.
    cmd.stdin(Stdio::piped());
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
}
