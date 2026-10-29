//! Settings › Providers: each harness's CLI (status, install, update, sign
//! in and out), over `hive_harness::provider`. A sign-in spans two calls:
//! `provider_sign_in` opens the browser and parks the CLI in [`SignIns`]
//! until `provider_finish_sign_in` brings the code (or, for a sign-in the
//! browser finishes on its own, waits for it), or it's cancelled.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use hive_harness::provider::{self, SignIn};
use hive_proto::{HarnessId, ProviderStatus, ProviderUsage, SignInMethod, SignInStarted};
use tauri::State;
use tokio::sync::Notify;

#[derive(Default)]
pub struct SignIns {
    next: AtomicU64,
    pending: Mutex<HashMap<String, SignIn>>,
    /// Sign-ins that finish in the browser, by login id: [`SignIn::finish`]
    /// holds them while it waits, so cancelling goes through this.
    cancels: Mutex<HashMap<String, Arc<Notify>>>,
}

impl SignIns {
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
    provider::usage(harness).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn provider_install(harness: HarnessId) -> Result<(), String> {
    provider::install(harness).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn provider_update(harness: HarnessId) -> Result<(), String> {
    provider::update(harness).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn provider_sign_out(harness: HarnessId) -> Result<(), String> {
    provider::sign_out(harness).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn provider_sign_in(
    sign_ins: State<'_, SignIns>,
    harness: HarnessId,
    method: SignInMethod,
) -> Result<SignInStarted, String> {
    let sign_in = SignIn::start(harness, method)
        .await
        .map_err(|e| e.to_string())?;
    let login_id = format!("login-{}", sign_ins.next.fetch_add(1, Ordering::Relaxed));
    let url = sign_in.url().to_owned();
    let needs_code = sign_in.needs_code();
    if let Some(cancel) = sign_in.canceller() {
        sign_ins.cancels().insert(login_id.clone(), cancel);
    }
    sign_ins.pending().insert(login_id.clone(), sign_in);
    Ok(SignInStarted {
        login_id,
        url,
        needs_code,
    })
}

/// Takes the sign-in either way: a wrong code ends it, and the next try
/// starts over.
#[tauri::command]
pub async fn provider_finish_sign_in(
    sign_ins: State<'_, SignIns>,
    login_id: String,
    code: String,
) -> Result<(), String> {
    let sign_in = sign_ins
        .pending()
        .remove(&login_id)
        .ok_or("This sign-in has ended. Start again.")?;
    let result = sign_in.finish(&code).await.map_err(|e| e.to_string());
    sign_ins.cancels().remove(&login_id);
    result
}

#[tauri::command]
pub fn provider_cancel_sign_in(sign_ins: State<'_, SignIns>, login_id: String) {
    // Dropping it kills the CLI; one already finishing is woken instead.
    sign_ins.pending().remove(&login_id);
    if let Some(cancel) = sign_ins.cancels().remove(&login_id) {
        cancel.notify_one();
    }
}
