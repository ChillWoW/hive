//! Antigravity as a provider (Settings › Providers): its status, signing in
//! and out, updating it, the newest release, and the plan's quota.

use std::sync::Mutex;

use outcode_harness::antigravity::provider::{self, SignInControl};
use outcode_proto::{ProviderStatus, SignInStarted, UsageWindow};
use serde_json::Value;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_opener::OpenerExt;

fn err(error: impl std::fmt::Display) -> String {
    error.to_string()
}

/// Whether `agy` is installed, its version, and whether it's signed in.
#[tauri::command]
pub async fn antigravity_status() -> ProviderStatus {
    provider::status(None).await
}

/// The sign-in in progress, if any.
#[derive(Default)]
pub struct SignIns(Mutex<Option<SignInControl>>);

/// How the sign-in in progress ends.
#[derive(Default)]
pub struct SignInResult(Mutex<Option<tokio::sync::oneshot::Receiver<Result<(), String>>>>);

/// Starts Google's sign-in and opens its page in the browser; the URL is
/// the fallback, for when that didn't work. The page ends on a code to paste
/// ([`antigravity_sign_in_code`]); [`antigravity_sign_in_wait`] waits for
/// the end.
#[tauri::command]
pub async fn antigravity_sign_in_start(app: AppHandle, sign_ins: State<'_, SignIns>) -> Result<SignInStarted, String> {
    if let Some(old) = sign_ins.0.lock().unwrap().take() {
        old.cancel();
    }
    let sign_in = provider::start_sign_in(None).await.map_err(err)?;
    let url = sign_in.url().to_owned();
    if let Err(error) = app.opener().open_url(&url, None::<&str>) {
        log::warn!("opening the Antigravity sign-in page: {error}");
    }
    *sign_ins.0.lock().unwrap() = Some(sign_in.control());
    let (tx, rx) = tokio::sync::oneshot::channel();
    tauri::async_runtime::spawn(async move {
        let _ = tx.send(sign_in.finish().await.map_err(err));
    });
    *app.state::<SignInResult>().0.lock().unwrap() = Some(rx);
    Ok(SignInStarted { url })
}

/// Waits for the sign-in in progress to finish.
#[tauri::command]
pub async fn antigravity_sign_in_wait(
    result: State<'_, SignInResult>,
    sign_ins: State<'_, SignIns>,
) -> Result<(), String> {
    let Some(rx) = result.0.lock().unwrap().take() else {
        return Err("No sign-in is in progress.".into());
    };
    let outcome = rx.await.unwrap_or_else(|_| Err("Sign-in ended.".into()));
    sign_ins.0.lock().unwrap().take();
    outcome
}

/// Hands the sign-in in progress the code from the Antigravity page.
#[tauri::command]
pub async fn antigravity_sign_in_code(sign_ins: State<'_, SignIns>, code: String) -> Result<(), String> {
    let control = sign_ins.0.lock().unwrap().clone();
    let Some(control) = control else {
        return Err("No sign-in is in progress.".into());
    };
    control.submit(&code).await.map_err(err)
}

#[tauri::command]
pub fn antigravity_sign_in_cancel(sign_ins: State<'_, SignIns>) {
    if let Some(control) = sign_ins.0.lock().unwrap().take() {
        control.cancel();
    }
}

#[tauri::command]
pub async fn antigravity_sign_out() -> Result<(), String> {
    provider::sign_out(None).await.map_err(err)
}

/// `agy update`.
#[tauri::command]
pub async fn antigravity_update() -> Result<(), String> {
    provider::update(None).await.map_err(err)
}

/// Google ships no script to run here: the page to install it from.
#[tauri::command]
pub async fn antigravity_install(app: AppHandle) -> Result<(), String> {
    let _ = app.opener().open_url(provider::INSTALL_URL, None::<&str>);
    Err(format!(
        "Install the Antigravity CLI from {}, then check again.",
        provider::INSTALL_URL
    ))
}

/// The newest release, from Google's updater manifest for this platform.
#[tauri::command]
pub async fn antigravity_latest_version() -> Result<String, String> {
    let url = provider::manifest_url().ok_or("No Antigravity release for this platform.")?;
    let client = crate::http::client().ok_or("No HTTP client.")?;
    let body: Value = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Couldn't reach Antigravity's updater: {}", e.without_url()))?
        .json()
        .await
        .map_err(err)?;
    body["version"]
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| "The updater didn't say which release is newest.".into())
}

/// The plan's quota windows; none signed out or with an API key.
#[tauri::command]
pub async fn antigravity_usage() -> Result<Option<Vec<UsageWindow>>, String> {
    provider::usage(None).await.map_err(err)
}
