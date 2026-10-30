//! Settings commands. The document lives in `hive_store::SettingsFile`; every
//! change is broadcast as [`CHANGED`] so all windows stay in sync.

use std::path::{Path, PathBuf};

use hive_engine::Engine;
use hive_proto::Settings;
use hive_store::SettingsFile;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};

pub const CHANGED: &str = "settings://changed";

fn broadcast(app: &AppHandle, (settings, changed): (Settings, bool)) -> Settings {
    if changed {
        if let Some(engine) = app.try_state::<Engine>() {
            apply(app, &engine, &settings);
        }
        let _ = app.emit(CHANGED, &settings);
    }
    settings
}

/// Hands the engine the settings it follows live.
pub fn apply<R: tauri::Runtime>(app: &impl Manager<R>, engine: &Engine, settings: &Settings) {
    engine.set_auto_title(settings.chats.auto_title);
    engine.set_text_generation(settings.text_generation.clone());
    let worktrees = &settings.worktrees;
    let home = app.path().home_dir().ok();
    engine.set_worktrees(
        worktrees_location(home.as_deref(), &worktrees.location),
        worktrees.branch_prefix.clone(),
        worktrees.delete_branch,
    );
}

/// The worktrees folder the user typed: `~` is the home folder; empty or
/// relative means the default (None).
fn worktrees_location(home: Option<&Path>, raw: &str) -> Option<PathBuf> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    let path = match raw.strip_prefix('~') {
        Some(rest) if rest.is_empty() || rest.starts_with(['/', '\\']) => {
            home?.join(rest.trim_start_matches(['/', '\\']))
        }
        _ => PathBuf::from(raw),
    };
    if !path.is_absolute() {
        log::warn!("worktree location {raw:?} isn't an absolute path; using the default");
        return None;
    }
    Some(path)
}

/// Where worktrees go while no location is set, for the settings field's
/// placeholder.
#[tauri::command]
pub fn worktrees_default_dir(engine: State<'_, Engine>) -> String {
    engine.default_worktrees_dir().display().to_string()
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
