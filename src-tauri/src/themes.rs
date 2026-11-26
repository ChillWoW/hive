//! User themes: one JSON file each in `<data dir>/themes/`, the same flat
//! object of colours as the built-in ones (`src/features/theme/themes.ts`).
//! The name is the file's `"name"` field, else the file name. Colours are
//! checked by the frontend; a file that isn't a JSON object is skipped, as is
//! any file starting with `_` (e.g. the generated `_template.json`).

use std::fs;
use std::path::PathBuf;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;

pub struct ThemesDir(pub PathBuf);

/// Starter file, rewritten on every launch so it tracks the current keys.
/// Files starting with `_` aren't listed, so copy it under another name.
const TEMPLATE_NAME: &str = "_template.json";
const TEMPLATE: &str = r##"{
    "name": "My Theme",
    "light": false,
    "bg": "#131315",
    "surface": "#18181a",
    "raised": "#1e1e21",
    "hover": "#252528",
    "border": "#2e2e32",
    "text": "#ededee",
    "muted": "#8e8e94",
    "accent": "#e6eeee",
    "accentFg": "#131315",
    "success": "#8fd68b",
    "danger": "#ff6b6b",
    "warning": "#f5b85c"
}
"##;

impl ThemesDir {
    pub fn open(dir: PathBuf) -> std::io::Result<Self> {
        fs::create_dir_all(&dir)?;
        let template = dir.join(TEMPLATE_NAME);
        if fs::read_to_string(&template).ok().as_deref() != Some(TEMPLATE) {
            if let Err(e) = fs::write(&template, TEMPLATE) {
                log::warn!("theme template {}: {e}", template.display());
            }
        }
        Ok(Self(dir))
    }
}

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
        .filter(|path| {
            !path
                .file_name()
                .is_some_and(|name| name.to_string_lossy().starts_with('_'))
        })
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
