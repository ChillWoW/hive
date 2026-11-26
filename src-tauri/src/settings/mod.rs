//! Settings commands. The document lives in [`SettingsFile`]; every change is
//! broadcast as [`CHANGED`] so all windows stay in sync.

mod file;
mod schema;

pub use file::SettingsFile;
pub use schema::*;

use serde_json::Value;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_opener::OpenerExt;

const CHANGED: &str = "settings://changed";

fn broadcast(app: &AppHandle, (settings, changed): (Settings, bool)) -> Settings {
    if changed {
        crate::claude::configure(&settings);
        let _ = app.emit(CHANGED, &settings);
    }
    settings
}

#[tauri::command]
pub fn settings_get(file: State<'_, SettingsFile>) -> Settings {
    file.get()
}

/// Deep-merges a partial document; returns what was stored.
#[tauri::command]
pub fn settings_update(
    app: AppHandle,
    file: State<'_, SettingsFile>,
    patch: Value,
) -> Result<Settings, String> {
    file.update(&patch)
        .map(|r| broadcast(&app, r))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn settings_reset(app: AppHandle, file: State<'_, SettingsFile>) -> Result<Settings, String> {
    file.reset()
        .map(|r| broadcast(&app, r))
        .map_err(|e| e.to_string())
}

/// Re-reads the file, for hand edits. Called when the window regains focus.
#[tauri::command]
pub fn settings_reload(app: AppHandle, file: State<'_, SettingsFile>) -> Result<Settings, String> {
    file.reload()
        .map(|r| broadcast(&app, r))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn settings_path(file: State<'_, SettingsFile>) -> String {
    file.path().display().to_string()
}

/// Shows the settings file in the OS file manager.
#[tauri::command]
pub fn settings_reveal(app: AppHandle, file: State<'_, SettingsFile>) -> Result<(), String> {
    app.opener()
        .reveal_item_in_dir(file.path())
        .map_err(|e| e.to_string())
}
