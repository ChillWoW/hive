//! Codex as a provider (Settings › Providers): its status, signing in and
//! out, installing and updating it, the newest release, and the plan's usage.

use std::sync::Mutex;

use outcode_harness::codex::provider::{self, SignInControl};
use outcode_proto::{ProviderStatus, SignInStarted, UsageWindow};
use serde_json::Value;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_opener::OpenerExt;

const NPM_URL: &str = "https://registry.npmjs.org/@openai/codex";

fn err(error: impl std::fmt::Display) -> String {
    error.to_string()
}

/// Whether Codex is installed, its version, and who is signed in.
#[tauri::command]
pub async fn codex_status() -> ProviderStatus {
    provider::status(None).await
}

/// The sign-in in progress, if any.
#[derive(Default)]
pub struct SignIns(Mutex<Option<SignInControl>>);

/// How the sign-in in progress ends.
#[derive(Default)]
pub struct SignInResult(Mutex<Option<tokio::sync::oneshot::Receiver<Result<(), String>>>>);

/// Starts ChatGPT's sign-in and opens its page in the browser; the URL is
/// the fallback, for when that didn't work. [`codex_sign_in_wait`] waits
/// for the end.
#[tauri::command]
pub async fn codex_sign_in_start(app: AppHandle, sign_ins: State<'_, SignIns>) -> Result<SignInStarted, String> {
    if let Some(old) = sign_ins.0.lock().unwrap().take() {
        old.cancel();
    }
    let sign_in = provider::start_sign_in(None).await.map_err(err)?;
    let url = sign_in.url().to_owned();
    if let Err(error) = app.opener().open_url(&url, None::<&str>) {
        log::warn!("opening the Codex sign-in page: {error}");
    }
    *sign_ins.0.lock().unwrap() = Some(sign_in.control());
    // Finishes on its own; the frontend hears it through `codex_sign_in_wait`.
    let (tx, rx) = tokio::sync::oneshot::channel();
    tauri::async_runtime::spawn(async move {
        let _ = tx.send(sign_in.finish().await.map_err(err));
    });
    *app.state::<SignInResult>().0.lock().unwrap() = Some(rx);
    Ok(SignInStarted { url })
}

/// Waits for the sign-in in progress to finish.
#[tauri::command]
pub async fn codex_sign_in_wait(result: State<'_, SignInResult>, sign_ins: State<'_, SignIns>) -> Result<(), String> {
    let Some(rx) = result.0.lock().unwrap().take() else {
        return Err("No sign-in is in progress.".into());
    };
    let outcome = rx.await.unwrap_or_else(|_| Err("Sign-in ended.".into()));
    sign_ins.0.lock().unwrap().take();
    outcome
}

#[tauri::command]
pub fn codex_sign_in_cancel(sign_ins: State<'_, SignIns>) {
    if let Some(control) = sign_ins.0.lock().unwrap().take() {
        control.cancel();
    }
}

/// `codex logout`.
#[tauri::command]
pub async fn codex_sign_out() -> Result<(), String> {
    provider::sign_out(None).await.map_err(err)
}

/// `codex update`.
#[tauri::command]
pub async fn codex_update() -> Result<(), String> {
    provider::update(None).await.map_err(err)
}

/// Runs OpenAI's installer.
#[tauri::command]
pub async fn codex_install() -> Result<(), String> {
    provider::install().await.map_err(err)
}

/// The newest release on npm (`latest` dist-tag).
#[tauri::command]
pub async fn codex_latest_version() -> Result<String, String> {
    let client = crate::http::client().ok_or("No HTTP client.")?;
    let body: Value = client
        .get(NPM_URL)
        .header(reqwest::header::ACCEPT, "application/vnd.npm.install-v1+json")
        .send()
        .await
        .map_err(|e| format!("Couldn't reach npm: {}", e.without_url()))?
        .json()
        .await
        .map_err(err)?;
    body.pointer("/dist-tags/latest")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| "npm didn't say which release is newest.".into())
}

/// The ChatGPT plan's rate-limit windows; none for an API key or while
/// signed out.
#[tauri::command]
pub async fn codex_usage() -> Result<Option<Vec<UsageWindow>>, String> {
    provider::usage(None).await.map_err(err)
}
