//! Managing each harness's CLI for Settings › Providers: probing it,
//! installing and updating it, signing in and out. Dispatches by
//! [`HarnessId`]; a harness without a CLI to manage answers
//! [`ProviderError::Unsupported`].

use std::sync::Arc;

use hive_proto::{HarnessId, ProviderStatus, ProviderUsage, SignInMethod};
use tokio::sync::Notify;

use crate::claude::{provider as claude, usage as claude_usage};
use crate::codex::provider as codex;

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
        _ => ProviderStatus {
            harness,
            // Mock runs in-process; the others aren't wired up yet.
            installed: harness == HarnessId::Mock,
            path: None,
            version: None,
            update_channel: None,
            account: None,
            error: None,
            can_install: false,
            can_update: false,
            can_sign_in: false,
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
        _ => Err(ProviderError::Unsupported),
    }
}

pub async fn update(harness: HarnessId) -> Result<(), ProviderError> {
    match harness {
        HarnessId::ClaudeCode => claude::update().await,
        HarnessId::Codex => codex::update().await,
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

/// A sign-in started in the browser: waiting for the code it shows
/// (Claude), or for the browser to finish on its own (Codex). Dropping it
/// cancels the sign-in.
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

    /// Whether [`SignIn::finish`] needs the code the page shows.
    pub fn needs_code(&self) -> bool {
        matches!(self, Self::Claude(_))
    }

    /// Cancels a [`SignIn::finish`] that's waiting on the browser, for a
    /// sign-in that needs no code.
    pub fn canceller(&self) -> Option<Arc<Notify>> {
        match self {
            Self::Claude(_) => None,
            Self::Codex(s) => Some(s.canceller()),
        }
    }

    pub async fn finish(self, code: &str) -> Result<(), ProviderError> {
        match self {
            Self::Claude(s) => s.finish(code).await,
            Self::Codex(s) => s.finish().await,
        }
    }
}
