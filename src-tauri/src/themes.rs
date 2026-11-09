//! User themes: one JSON file each in `<data dir>/themes/`, the same flat
//! object of colours as the built-in ones (`src/features/theme/themes.ts`).
//! The name is the file's `"name"` field, else the file name. Colours are
//! checked by the frontend; a file that isn't a JSON object is skipped.

use std::fs;
use std::path::PathBuf;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;

pub struct ThemesDir(pub PathBuf);

#[derive(Serialize)]
pub struct UserTheme {
    name: String,
    colors: Value,
}

#[tauri::command]
pub fn themes_list(dir: State<'_, ThemesDir>) -> Vec<UserTheme> {
    let Ok(entries) = fs::read_dir(&dir.0) else {
        return Vec::new();
    };
    let mut themes: Vec<UserTheme> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
        .filter_map(|path| {
            let text = fs::read_to_string(&path).ok()?;
            let colors: Value = serde_json::from_str(&text)
                .inspect_err(|e| log::warn!("theme {}: {e}", path.display()))
                .ok()?;
            if !colors.is_object() {
                return None;
            }
            let name = match colors.get("name").and_then(Value::as_str).map(str::trim) {
                Some(name) if !name.is_empty() => name.to_owned(),
                _ => path.file_stem()?.to_string_lossy().into_owned(),
            };
            Some(UserTheme { name, colors })
        })
        .collect();
    themes.sort_by_key(|theme| theme.name.to_lowercase());
    themes
}

/// Opens the themes folder in the OS file manager.
#[tauri::command]
pub fn themes_open_dir(app: AppHandle, dir: State<'_, ThemesDir>) -> Result<(), String> {
    fs::create_dir_all(&dir.0).map_err(|e| e.to_string())?;
    app.opener()
        .open_path(dir.0.to_string_lossy(), None::<&str>)
        .map_err(|e| e.to_string())
}
