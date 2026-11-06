//! Settings › Providers: each harness's CLI (status, install, update, sign
//! in and out), over `hive_harness::provider`. A sign-in spans two calls:
//! `provider_sign_in` starts the CLI and parks it in [`SignIns`], then
//! `provider_finish_sign_in` waits for the browser to finish it, or for it
//! to be cancelled. Claude's fallback page shows a code instead, which
//! `provider_submit_sign_in_code` hands the waiting CLI.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use hive_harness::provider::{self, CodeInput, SignIn};
use hive_proto::{HarnessId, ProviderStatus, ProviderUsage, SignInMethod, SignInStarted};
use tauri::State;
use tokio::sync::Notify;

use crate::util::err;

#[derive(Default)]
pub struct SignIns {
    next: AtomicU64,
    pending: Mutex<HashMap<String, SignIn>>,
    /// Sign-ins that finish in the browser, by login id: [`SignIn::finish`]
    /// holds them while it waits, so cancelling goes through this.
    cancels: Mutex<HashMap<String, Arc<Notify>>>,
    /// Where a pasted code goes while [`SignIn::finish`] waits (Claude).
    codes: Mutex<HashMap<String, CodeInput>>,
}

impl SignIns {
    fn codes(&self) -> std::sync::MutexGuard<'_, HashMap<String, CodeInput>> {
        self.codes.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn pending(&self) -> std::sync::MutexGuard<'_, HashMap<String, SignIn>> {
        self.pending.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn cancels(&self) -> std::sync::MutexGuard<'_, HashMap<String, Arc<Notify>>> {
        self.cancels.lock().unwrap_or_else(|e| e.into_inner())
    }
}

#[tauri::command]
pub async fn provider_status(harness: HarnessId) -> ProviderStatus {
    provider::status(harness).await
}

#[tauri::command]
pub async fn provider_usage(harness: HarnessId) -> Result<Option<ProviderUsage>, String> {
    provider::usage(harness).await.map_err(err)
}

#[tauri::command]
pub async fn provider_install(harness: HarnessId) -> Result<(), String> {
    provider::install(harness).await.map_err(err)
}

#[tauri::command]
pub async fn provider_update(harness: HarnessId) -> Result<(), String> {
    provider::update(harness).await.map_err(err)
}

#[tauri::command]
pub async fn provider_sign_out(harness: HarnessId) -> Result<(), String> {
    provider::sign_out(harness).await.map_err(err)
}

#[tauri::command]
pub async fn provider_sign_in(
    sign_ins: State<'_, SignIns>,
    harness: HarnessId,
    method: SignInMethod,
) -> Result<SignInStarted, String> {
    let sign_in = SignIn::start(harness, method).await.map_err(err)?;
    let login_id = format!("login-{}", sign_ins.next.fetch_add(1, Ordering::Relaxed));
    let url = sign_in.url().to_owned();
    let opened = sign_in.opened();
    sign_ins.cancels().insert(login_id.clone(), sign_in.canceller());
    let code = sign_in.code_input();
    let accepts_code = code.is_some();
    if let Some(code) = code {
        sign_ins.codes().insert(login_id.clone(), code);
    }
    sign_ins.pending().insert(login_id.clone(), sign_in);
    Ok(SignInStarted {
        login_id,
        url,
        opened,
        accepts_code,
    })
}

/// Waits for the browser (or a code pasted meanwhile) to finish it.
#[tauri::command]
pub async fn provider_finish_sign_in(
    sign_ins: State<'_, SignIns>,
    login_id: String,
) -> Result<(), String> {
    let sign_in = sign_ins
        .pending()
        .remove(&login_id)
        .ok_or("This sign-in has ended. Start again.")?;
    let result = sign_in.finish().await.map_err(err);
    sign_ins.cancels().remove(&login_id);
    sign_ins.codes().remove(&login_id);
    result
}

/// A code from the fallback page, for a sign-in `provider_finish_sign_in`
/// is waiting on; that call ends with how it went.
#[tauri::command]
pub async fn provider_submit_sign_in_code(
    sign_ins: State<'_, SignIns>,
    login_id: String,
    code: String,
) -> Result<(), String> {
    let input = sign_ins
        .codes()
        .get(&login_id)
        .cloned()
        .ok_or("This sign-in has ended. Start again.")?;
    input.submit(&code).await.map_err(err)
}

#[tauri::command]
pub fn provider_cancel_sign_in(sign_ins: State<'_, SignIns>, login_id: String) {
    // Dropping it kills the CLI; one already finishing is woken instead.
    sign_ins.pending().remove(&login_id);
    sign_ins.codes().remove(&login_id);
    if let Some(cancel) = sign_ins.cancels().remove(&login_id) {
        cancel.notify_one();
    }
}
