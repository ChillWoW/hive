//! Managing each harness's CLI for Settings › Providers: probing it,
//! installing and updating it, signing in and out. Dispatches by
//! [`HarnessId`]; a harness without a CLI to manage answers
//! [`ProviderError::Unsupported`].

use hive_proto::{HarnessId, ProviderStatus, SignInMethod};

use crate::claude::provider as claude;

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

pub async fn install(harness: HarnessId) -> Result<(), ProviderError> {
    match harness {
        HarnessId::ClaudeCode => claude::install().await,
        _ => Err(ProviderError::Unsupported),
    }
}

pub async fn update(harness: HarnessId) -> Result<(), ProviderError> {
    match harness {
        HarnessId::ClaudeCode => claude::update().await,
        _ => Err(ProviderError::Unsupported),
    }
}

pub async fn sign_out(harness: HarnessId) -> Result<(), ProviderError> {
    match harness {
        HarnessId::ClaudeCode => claude::sign_out().await,
        _ => Err(ProviderError::Unsupported),
    }
}

/// A sign-in started in the browser, waiting for the code it shows.
/// Dropping it cancels the sign-in.
pub enum SignIn {
    Claude(claude::SignIn),
}

impl SignIn {
    pub async fn start(harness: HarnessId, method: SignInMethod) -> Result<Self, ProviderError> {
        match harness {
            HarnessId::ClaudeCode => claude::start_sign_in(method).await.map(Self::Claude),
            _ => Err(ProviderError::Unsupported),
        }
    }

    /// The page to approve access on.
    pub fn url(&self) -> &str {
        match self {
            Self::Claude(s) => s.url(),
        }
    }

    pub async fn finish(self, code: &str) -> Result<(), ProviderError> {
        match self {
            Self::Claude(s) => s.finish(code).await,
        }
    }
}
