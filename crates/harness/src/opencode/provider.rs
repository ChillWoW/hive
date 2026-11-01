//! OpenCode's CLI as a provider: its version (`opencode --version`), the
//! credentials it holds (`opencode auth list`), installing it (npm's
//! `@opencode/cli`, which is OpenCode 2; the curl installer only installs
//! OpenCode 1) and updating it (`opencode upgrade`).
//!
//! Signing in is per model provider in OpenCode's own `opencode auth
//! login`, so it isn't offered here.

use std::path::{Path, PathBuf};
use std::time::Duration;

use hive_proto::{HarnessId, ProviderAccount, ProviderStatus};
use tokio::process::Command;

use super::find_opencode;
use crate::cli;
use crate::provider::{
    self, captured, parse_version, run_ok, strip_ansi, ProviderError, UPDATE_TIMEOUT,
};

const PROBE_TIMEOUT: Duration = Duration::from_secs(20);
/// The npm package OpenCode 2 ships as.
const PACKAGE: &str = "@opencode/cli";

/// `opencode v2.2.0` → `2.2.0`.
fn version_of(text: &str) -> Option<String> {
    let words: Vec<&str> = text.split_whitespace().map(|w| w.trim_start_matches('v')).collect();
    parse_version(&words.join(" "))
}

fn installed() -> Result<PathBuf, ProviderError> {
    find_opencode().ok_or(ProviderError::NotInstalled("opencode"))
}

fn cli(exe: &Path) -> Command {
    captured(crate::overrides::command(HarnessId::Opencode, exe))
}

pub async fn status() -> ProviderStatus {
    let exe = find_opencode();
    let mut status = provider::found(HarnessId::Opencode, exe.as_deref());
    let Some(exe) = exe else {
        return status;
    };
    // `@opencode/cli`'s npm dist-tag, for the newest-release check.
    status.update_channel = Some("latest".into());

    let mut version = cli(&exe);
    version.arg("--version");
    // A private server: the default would start OpenCode's background one.
    let mut auth = cli(&exe);
    auth.args(["auth", "list", "--standalone"]);
    let (version, auth) =
        tokio::join!(run_ok(version, PROBE_TIMEOUT), run_ok(auth, PROBE_TIMEOUT));

    let mut errors = Vec::new();
    match version {
        Ok(out) => status.version = version_of(&out.stdout),
        Err(e) => errors.push(format!("version check failed: {e}")),
    }
    match auth {
        Ok(out) => status.account = Some(parse_account(&out.stdout)),
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
    let mut cmd = if let Some(npm) = cli::find_on_path("npm") {
        let mut cmd = cli(&npm);
        cmd.args(["install", "-g", PACKAGE]);
        cmd
    } else if let Some(bun) = cli::find_on_path("bun") {
        let mut cmd = cli(&bun);
        cmd.args(["add", "-g", PACKAGE]);
        cmd
    } else {
        return Err(ProviderError::Failed(format!(
            "Installing OpenCode needs npm (Node.js) or bun. Install one, or run `npm install -g {PACKAGE}` yourself."
        )));
    };
    cmd.env("CI", "1");
    provider::run_installer(
        cmd,
        || installed().is_ok(),
        "The install finished, but `opencode` wasn't found. Add the global package folder to \
         PATH and restart Hive.",
    )
    .await
}

/// `opencode upgrade`: the newest release, through whatever installed it.
pub async fn update() -> Result<(), ProviderError> {
    let mut cmd = cli(&installed()?);
    cmd.arg("upgrade");
    run_ok(cmd, UPDATE_TIMEOUT).await.map(drop)
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
