//! Managing each harness's CLI for Settings › Providers: probing it,
//! installing and updating it, signing in and out. Dispatches by
//! [`HarnessId`]; a harness without a CLI to manage answers
//! [`ProviderError::Unsupported`].

use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use hive_proto::{HarnessId, ProviderStatus, ProviderUsage, SignInMethod};
use tokio::process::Command;
use tokio::sync::Notify;

use crate::claude::{provider as claude, usage as claude_usage};
use crate::cli;
use crate::codex::provider as codex;
use crate::opencode::provider as opencode;

pub use crate::claude::provider::CodeInput;

pub(crate) const INSTALL_TIMEOUT: Duration = Duration::from_secs(15 * 60);
pub(crate) const UPDATE_TIMEOUT: Duration = Duration::from_secs(10 * 60);

#[derive(Debug, thiserror::Error)]
pub enum ProviderError {
    #[error("{0} is not installed")]
    NotInstalled(&'static str),
    #[error("not supported for this provider")]
    Unsupported,
    #[error("timed out")]
    TimedOut,
    #[error("{0}")]
    Failed(String),
}

/// Never fails: what couldn't be checked lands in [`ProviderStatus::error`].
pub async fn status(harness: HarnessId) -> ProviderStatus {
    match harness {
        HarnessId::ClaudeCode => claude::status().await,
        HarnessId::Codex => codex::status().await,
        HarnessId::Opencode => opencode::status().await,
        _ => ProviderStatus {
            // Mock runs in-process.
            installed: harness == HarnessId::Mock,
            can_install: false,
            ..found(harness, None)
        },
    }
}

/// The signed-in account's plan usage; `None` when there's nothing to
/// show (no subscription login, or a harness that doesn't report usage).
pub async fn usage(harness: HarnessId) -> Result<Option<ProviderUsage>, ProviderError> {
    match harness {
        HarnessId::ClaudeCode => claude_usage::usage().await,
        HarnessId::Codex => codex::usage().await,
        _ => Ok(None),
    }
}

pub async fn install(harness: HarnessId) -> Result<(), ProviderError> {
    match harness {
        HarnessId::ClaudeCode => claude::install().await,
        HarnessId::Codex => codex::install().await,
        HarnessId::Opencode => opencode::install().await,
        _ => Err(ProviderError::Unsupported),
    }
}

pub async fn update(harness: HarnessId) -> Result<(), ProviderError> {
    match harness {
        HarnessId::ClaudeCode => claude::update().await,
        HarnessId::Codex => codex::update().await,
        HarnessId::Opencode => opencode::update().await,
        _ => Err(ProviderError::Unsupported),
    }
}

pub async fn sign_out(harness: HarnessId) -> Result<(), ProviderError> {
    match harness {
        HarnessId::ClaudeCode => claude::sign_out().await,
        HarnessId::Codex => codex::sign_out().await,
        _ => Err(ProviderError::Unsupported),
    }
}

/// A sign-in started in the browser, waiting for it to finish (or, for
/// Claude, a code its fallback page shows). Dropping it cancels the sign-in.
pub enum SignIn {
    Claude(claude::SignIn),
    Codex(codex::SignIn),
}

impl SignIn {
    /// Codex has one way in (ChatGPT), whatever `method` says.
    pub async fn start(harness: HarnessId, method: SignInMethod) -> Result<Self, ProviderError> {
        match harness {
            HarnessId::ClaudeCode => claude::start_sign_in(method).await.map(Self::Claude),
            HarnessId::Codex => codex::start_sign_in().await.map(Self::Codex),
            _ => Err(ProviderError::Unsupported),
        }
    }

    /// The page to approve access on.
    pub fn url(&self) -> &str {
        match self {
            Self::Claude(s) => s.url(),
            Self::Codex(s) => s.url(),
        }
    }

    /// Whether the CLI opened its own page already ([`SignIn::url`] being
    /// the fallback); else the app opens `url`.
    pub fn opened(&self) -> bool {
        matches!(self, Self::Claude(_))
    }

    /// Where a code the fallback page shows goes, while [`SignIn::finish`]
    /// waits (Claude).
    pub fn code_input(&self) -> Option<CodeInput> {
        match self {
            Self::Claude(s) => Some(s.code_input()),
            Self::Codex(_) => None,
        }
    }

    /// Cancels a [`SignIn::finish`] that's waiting on the browser.
    pub fn canceller(&self) -> Arc<Notify> {
        match self {
            Self::Claude(s) => s.canceller(),
            Self::Codex(s) => s.canceller(),
        }
    }

    /// Waits for the browser (or a pasted code) to finish the sign-in.
    pub async fn finish(self) -> Result<(), ProviderError> {
        match self {
            Self::Claude(s) => s.finish().await,
            Self::Codex(s) => s.finish().await,
        }
    }
}

/// A harness's status before its CLI is asked anything: whether `exe` was
/// found, and where. It can be installed, and updated once found.
pub(crate) fn found(harness: HarnessId, exe: Option<&Path>) -> ProviderStatus {
    ProviderStatus {
        harness,
        installed: exe.is_some(),
        path: exe.map(|exe| exe.display().to_string()),
        version: None,
        update_channel: None,
        account: None,
        error: None,
        can_install: true,
        can_update: exe.is_some(),
        can_sign_in: false,
    }
}

/// `cmd` with nothing on stdin and its output captured; killed if dropped.
pub(crate) fn captured(mut cmd: Command) -> Command {
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    cmd
}

/// A vendor's install script: `irm <ps1> | iex` in PowerShell on Windows,
/// else `curl -fsSL <sh> | <shell>`.
pub(crate) fn install_script(ps1: &str, sh: &str, shell: &str) -> Command {
    let mut cmd = if cfg!(windows) {
        let mut cmd = Command::new("powershell.exe");
        cmd.args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            &format!("irm {ps1} | iex"),
        ]);
        cmd
    } else {
        let mut cmd = Command::new(format!("/bin/{shell}"));
        cmd.args(["-c", &format!("curl -fsSL {sh} | {shell}")]);
        cmd
    };
    cmd.env("CI", "1").env("NONINTERACTIVE", "1");
    cli::no_window(&mut cmd);
    captured(cmd)
}

/// Runs an installer, then checks that it left the CLI where `installed`
/// finds it; `missing` says what to do when it didn't.
pub(crate) async fn run_installer(
    cmd: Command,
    installed: impl FnOnce() -> bool,
    missing: &str,
) -> Result<(), ProviderError> {
    run_ok(cmd, INSTALL_TIMEOUT).await?;
    if installed() {
        Ok(())
    } else {
        Err(ProviderError::Failed(missing.into()))
    }
}

pub(crate) struct Output {
    pub(crate) success: bool,
    pub(crate) stdout: String,
    stderr: String,
}

impl Output {
    /// What to show when it failed: the last lines it printed.
    pub(crate) fn failure(&self) -> ProviderError {
        let text = if self.stderr.trim().is_empty() {
            &self.stdout
        } else {
            &self.stderr
        };
        ProviderError::Failed(tail(&strip_ansi(text)))
    }
}

pub(crate) async fn run(mut cmd: Command, timeout: Duration) -> Result<Output, ProviderError> {
    let child = cmd
        .spawn()
        .map_err(|e| ProviderError::Failed(e.to_string()))?;
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

/// [`run`], failing unless the command succeeded.
pub(crate) async fn run_ok(cmd: Command, timeout: Duration) -> Result<Output, ProviderError> {
    let out = run(cmd, timeout).await?;
    if out.success {
        Ok(out)
    } else {
        Err(out.failure())
    }
}

/// `"2.1.312 (Claude Code)"` → `"2.1.312"`.
pub(crate) fn parse_version(text: &str) -> Option<String> {
    text.split_whitespace()
        .find(|word| word.starts_with(|c: char| c.is_ascii_digit()) && word.contains('.'))
        .map(str::to_owned)
}

/// Drops terminal escape sequences (colours, cursor moves).
pub(crate) fn strip_ansi(text: &str) -> String {
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
pub(crate) fn tail(text: &str) -> String {
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
    fn strips_escapes() {
        assert_eq!(strip_ansi("\u{1b}[31merror\u{1b}[0m: bad"), "error: bad");
    }
}
