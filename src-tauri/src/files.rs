//! Files the user opens from the app.

use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

/// Opens `path` in the system's default app for it.
#[tauri::command]
pub fn file_open(app: AppHandle, path: String) -> Result<(), String> {
    if !std::path::Path::new(&path).is_file() {
        return Err(format!("{path} doesn't exist"));
    }
    app.opener()
        .open_path(&path, None::<&str>)
        .map_err(|e| e.to_string())
}
