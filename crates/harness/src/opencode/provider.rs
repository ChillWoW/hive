//! OpenCode's CLI as a provider: its version (`opencode --version`), the
//! credentials it holds (`opencode auth list`), installing it (npm's
//! `@opencode/cli`, which is OpenCode 2; the curl installer only installs
//! OpenCode 1) and updating it (`opencode upgrade`).
//!
//! Signing in is per model provider in OpenCode's own `opencode auth
//! login`, so it isn't offered here.

use std::process::Stdio;
use std::time::Duration;

use hive_proto::{HarnessId, ProviderAccount, ProviderStatus};
use tokio::process::Command;

use super::find_opencode;
use crate::claude::command_for;
use crate::claude::find_on_path;
use crate::claude::provider::{no_window, parse_version, run, strip_ansi};

/// `opencode v2.2.0` → `2.2.0`.
fn version_of(text: &str) -> Option<String> {
    parse_version(&text.split_whitespace().map(|w| w.trim_start_matches('v')).collect::<Vec<_>>().join(" "))
}
use crate::provider::ProviderError;

const PROBE_TIMEOUT: Duration = Duration::from_secs(20);
const INSTALL_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const UPDATE_TIMEOUT: Duration = Duration::from_secs(10 * 60);
/// The npm package OpenCode 2 ships as.
const PACKAGE: &str = "@opencode/cli";

fn installed() -> Result<std::path::PathBuf, ProviderError> {
    find_opencode().ok_or(ProviderError::NotInstalled("opencode"))
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
        harness: HarnessId::Opencode,
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
    let Some(exe) = find_opencode() else {
        return status;
    };
    status.installed = true;
    status.path = Some(exe.display().to_string());
    status.can_update = true;
    // `@opencode/cli`'s npm dist-tag, for the newest-release check.
    status.update_channel = Some("latest".into());

    let mut version = cli(&exe);
    version.arg("--version");
    // A private server: the default would start OpenCode's background one.
    let mut auth = cli(&exe);
    auth.args(["auth", "list", "--standalone"]);
    let (version, auth) = tokio::join!(run(version, PROBE_TIMEOUT), run(auth, PROBE_TIMEOUT));

    let mut errors = Vec::new();
    match version {
        Ok(out) if out.success => status.version = version_of(&out.stdout),
        Ok(out) => errors.push(format!("version check failed: {}", out.failure())),
        Err(e) => errors.push(format!("version check failed: {e}")),
    }
    match auth {
        Ok(out) if out.success => status.account = Some(parse_account(&out.stdout)),
        Ok(out) => errors.push(format!("credentials check failed: {}", out.failure())),
        Err(e) => errors.push(format!("credentials check failed: {e}")),
    }
    if !errors.is_empty() {
        status.error = Some(errors.join("; "));
    }
    status
}

/// `opencode auth list`: one line per stored credential, its provider's
/// name first (`OpenRouter  API key  stored`).
fn parse_account(text: &str) -> ProviderAccount {
    let providers: Vec<String> = strip_ansi(text)
        .lines()
        .filter_map(|line| {
            let name = line.trim().split("  ").next()?.trim();
            let plain = !name.is_empty()
                && name
                    .chars()
                    .all(|c| c.is_alphanumeric() || matches!(c, ' ' | '-' | '.' | '_'));
            plain.then(|| name.to_owned())
        })
        .collect();
    ProviderAccount {
        logged_in: !providers.is_empty(),
        method: (!providers.is_empty()).then(|| providers.join(", ")),
        email: None,
        organization: None,
        plan: None,
    }
}

/// Installs `@opencode/cli` globally with npm, else bun.
pub async fn install() -> Result<(), ProviderError> {
    let mut cmd = if let Some(npm) = find_on_path("npm") {
        let mut cmd = command_for(&npm);
        cmd.args(["install", "-g", PACKAGE]);
        cmd
    } else if let Some(bun) = find_on_path("bun") {
        let mut cmd = command_for(&bun);
        cmd.args(["add", "-g", PACKAGE]);
        cmd
    } else {
        return Err(ProviderError::Failed(format!(
            "Installing OpenCode needs npm (Node.js) or bun. Install one, or run `npm install -g {PACKAGE}` yourself."
        )));
    };
    cmd.env("CI", "1")
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
            "The install finished, but `opencode` wasn't found. Add the global package folder to PATH and restart Hive."
                .into(),
        )
    })
}

/// `opencode upgrade`: the newest release, through whatever installed it.
pub async fn update() -> Result<(), ProviderError> {
    let mut cmd = cli(&installed()?);
    cmd.arg("upgrade");
    let out = run(cmd, UPDATE_TIMEOUT).await?;
    if out.success {
        Ok(())
    } else {
        Err(out.failure())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credentials_name_the_providers() {
        let account = parse_account(
            "Google      OAuth                       stored\nOpenRouter  API key                     stored\n",
        );
        assert!(account.logged_in);
        assert_eq!(account.method.as_deref(), Some("Google, OpenRouter"));
        assert!(!parse_account("").logged_in);
        assert_eq!(version_of("opencode v2.2.0\n").as_deref(), Some("2.2.0"));
    }
}
