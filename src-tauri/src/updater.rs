//! App updates from GitHub Releases (`plugins.updater` in tauri.conf.json).
//! Nothing is downloaded until the user asks: `update_check` only reads
//! `latest.json`; `update_install` downloads, stops the agents and
//! terminals, installs and restarts.

use std::sync::Mutex;
use std::time::Duration;

use hive_engine::Engine;
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, State};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::terminals::Terminals;

/// How long agents get to exit before the installer takes over.
const SHUTDOWN_GRACE: Duration = Duration::from_secs(5);
/// Progress is reported at most this often (in bytes).
const PROGRESS_STEP: u64 = 256 * 1024;

/// The update the last check found.
#[derive(Default)]
pub struct Updates(Mutex<Option<Update>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    version: String,
    current_version: String,
    notes: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum UpdateProgress {
    Downloading { downloaded: u64, total: Option<u64> },
    /// Downloaded; stopping agents and handing over to the installer.
    Installing,
}

/// The newer release, if there is one. Dev builds never update.
#[tauri::command]
pub async fn update_check(
    app: AppHandle,
    updates: State<'_, Updates>,
) -> Result<Option<UpdateInfo>, String> {
    if cfg!(debug_assertions) {
        return Ok(None);
    }
    let update = app
        .updater()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?;
    let info = update.as_ref().map(|u| UpdateInfo {
        version: u.version.clone(),
        current_version: u.current_version.clone(),
        notes: u.body.clone().filter(|b| !b.trim().is_empty()),
    });
    *updates.0.lock().unwrap() = update;
    Ok(info)
}

/// Downloads the update `update_check` found, then stops every agent and
/// terminal and installs it. On Windows the installer closes Hive and opens
/// it again; elsewhere Hive restarts itself. Only returns on failure.
#[tauri::command]
pub async fn update_install(
    app: AppHandle,
    updates: State<'_, Updates>,
    engine: State<'_, Engine>,
    terminals: State<'_, Terminals>,
    on_progress: Channel<UpdateProgress>,
) -> Result<(), String> {
    let update = updates
        .0
        .lock()
        .unwrap()
        .clone()
        .ok_or("There's no update to install.")?;

    let mut downloaded = 0u64;
    let mut reported = 0u64;
    let bytes = update
        .download(
            |chunk, total| {
                downloaded += chunk as u64;
                if downloaded - reported >= PROGRESS_STEP || Some(downloaded) == total {
                    reported = downloaded;
                    let _ = on_progress.send(UpdateProgress::Downloading { downloaded, total });
                }
            },
            || {},
        )
        .await
        .map_err(|e| format!("Couldn't download the update: {e}"))?;

    let _ = on_progress.send(UpdateProgress::Installing);
    engine.shutdown(SHUTDOWN_GRACE).await;
    terminals.kill_all();
    update
        .install(bytes)
        .map_err(|e| format!("Couldn't install the update: {e}"))?;
    app.restart()
}
