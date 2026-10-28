//! Settings commands. The document lives in `hive_store::SettingsFile`; every
//! change is broadcast as [`CHANGED`] so all windows stay in sync.

use hive_engine::Engine;
use hive_proto::Settings;
use hive_store::SettingsFile;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};

pub const CHANGED: &str = "settings://changed";

fn broadcast(app: &AppHandle, (settings, changed): (Settings, bool)) -> Settings {
    if changed {
        if let Some(engine) = app.try_state::<Engine>() {
            apply(&engine, &settings);
        }
        let _ = app.emit(CHANGED, &settings);
    }
    settings
}

/// Hands the engine the settings it follows live.
fn apply(engine: &Engine, settings: &Settings) {
    engine.set_auto_title(settings.chats.auto_title);
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
pub fn settings_reveal(file: State<'_, SettingsFile>) -> Result<(), String> {
    let path = file.path();
    #[cfg(windows)]
    let result = {
        use std::os::windows::process::CommandExt;
        // explorer parses `/select,` itself and mangles a fully quoted arg.
        std::process::Command::new("explorer")
            .raw_arg(format!("/select,\"{}\"", path.display()))
            .spawn()
    };
    #[cfg(target_os = "macos")]
    let result = std::process::Command::new("open").arg("-R").arg(path).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let result = std::process::Command::new("xdg-open")
        .arg(path.parent().unwrap_or(path))
        .spawn();
    result.map(|_| ()).map_err(|e| e.to_string())
}
