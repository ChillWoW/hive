//! Pi's CLI as a provider: its version (`pi --version`), the model
//! providers it holds credentials for (`auth.json` in its agent folder),
//! installing it (npm's `@earendil-works/pi-coding-agent`) and updating it
//! (`pi update --self`, through whatever installed it).
//!
//! Signing in is per model provider, in Pi's own `/login`, so it isn't
//! offered here.

use std::path::PathBuf;
use std::time::Duration;

use hive_proto::{HarnessId, ProviderAccount, ProviderStatus};
use serde_json::Value;

use super::find_pi;
use crate::cli;
use crate::provider::{self, captured, parse_version, run_ok, ProviderError, UPDATE_TIMEOUT};

const PROBE_TIMEOUT: Duration = Duration::from_secs(20);
/// The npm package Pi ships as.
pub const PACKAGE: &str = "@earendil-works/pi-coding-agent";

fn installed() -> Result<PathBuf, ProviderError> {
    find_pi().ok_or(ProviderError::NotInstalled("pi"))
}

/// Pi's config folder: `PI_CODING_AGENT_DIR`, else `~/.pi/agent`.
fn agent_dir() -> Option<PathBuf> {
    crate::overrides::env_var(HarnessId::Pi, "PI_CODING_AGENT_DIR")
        .map(PathBuf::from)
        .or_else(|| Some(cli::home_dir()?.join(".pi").join("agent")))
}

pub async fn status() -> ProviderStatus {
    let exe = find_pi();
    let mut status = provider::found(HarnessId::Pi, exe.as_deref());
    let Some(exe) = exe else {
        return status;
    };
    status.update_channel = Some("latest".into());
    let mut version = captured(crate::overrides::command(HarnessId::Pi, &exe));
    version.arg("--version");
    match run_ok(version, PROBE_TIMEOUT).await {
        Ok(out) => status.version = parse_version(&out.stdout),
        Err(e) => status.error = Some(format!("version check failed: {e}")),
    }
    // Keys in the environment count too, so no stored credential isn't
    // "signed out": the account is left unknown then.
    let auth = agent_dir().map(|d| d.join("auth.json"));
    if let Some(text) = auth.and_then(|path| std::fs::read_to_string(path).ok()) {
        status.account = parse_account(&text);
    }
    status
}

/// `auth.json`: an object keyed by provider.
fn parse_account(text: &str) -> Option<ProviderAccount> {
    let auth: Value = serde_json::from_str(text).ok()?;
    let providers: Vec<&String> = auth.as_object()?.keys().collect();
    if providers.is_empty() {
        return None;
    }
    Some(ProviderAccount {
        logged_in: true,
        method: Some(
            providers
                .iter()
                .map(|p| p.as_str())
                .collect::<Vec<_>>()
                .join(", "),
        ),
        email: None,
        organization: None,
        plan: None,
    })
}

/// Installs Pi globally with npm, else bun.
pub async fn install() -> Result<(), ProviderError> {
    let mut cmd = if let Some(npm) = cli::find_on_path("npm") {
        let mut cmd = captured(crate::overrides::command(HarnessId::Pi, &npm));
        cmd.args(["install", "-g", PACKAGE]);
        cmd
    } else if let Some(bun) = cli::find_on_path("bun") {
        let mut cmd = captured(crate::overrides::command(HarnessId::Pi, &bun));
        cmd.args(["add", "-g", PACKAGE]);
        cmd
    } else {
        return Err(ProviderError::Failed(
            "Installing Pi needs npm (Node.js) or bun. Install one, or use the installer at https://pi.dev."
                .into(),
        ));
    };
    cmd.env("CI", "1");
    provider::run_installer(
        cmd,
        || installed().is_ok(),
        "The install finished, but `pi` wasn't found. Add the global package folder to PATH \
         and restart Hive.",
    )
    .await
}

/// `pi update --self`.
pub async fn update() -> Result<(), ProviderError> {
    let mut cmd = captured(crate::overrides::command(HarnessId::Pi, &installed()?));
    cmd.args(["update", "--self"]);
    run_ok(cmd, UPDATE_TIMEOUT).await.map(drop)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credentials_name_the_providers() {
        let account = parse_account(r#"{"anthropic":{"type":"oauth"},"openai":{"type":"api_key"}}"#).unwrap();
        assert_eq!(account.method.as_deref(), Some("anthropic, openai"));
        assert!(parse_account("{}").is_none());
    }
}
