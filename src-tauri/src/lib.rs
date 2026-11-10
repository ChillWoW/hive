mod http;
mod settings;
mod themes;
mod updater;

use std::path::PathBuf;

use tauri::Manager;
use tauri_plugin_window_state::StateFlags;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Geometry only: the saved file would otherwise also pin `decorations`
        // and visibility, so a later change to either in tauri.conf.json would
        // be overridden by whatever the last run left behind.
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(StateFlags::POSITION | StateFlags::SIZE | StateFlags::MAXIMIZED)
                .build(),
        )
        .plugin(tauri_plugin_log::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let data_dir = data_dir(app)?;
            app.manage(settings::SettingsFile::open(&data_dir)?);
            let themes_dir = data_dir.join("themes");
            std::fs::create_dir_all(&themes_dir)?;
            app.manage(themes::ThemesDir(themes_dir));
            app.manage(updater::Updates::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            settings::settings_get,
            settings::settings_update,
            settings::settings_reset,
            settings::settings_reload,
            settings::settings_path,
            settings::settings_reveal,
            themes::themes_list,
            themes::themes_open_dir,
            updater::update_check,
            updater::update_install,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// `~/.outcode`, or `~/.outcode.dev` for the dev config (`com.outcode.dev`).
/// A data dir from before the rename (`~/.hive`, `~/.hive.dev`) is moved over.
fn data_dir(app: &tauri::App) -> tauri::Result<PathBuf> {
    let (name, legacy) = if app.config().identifier.ends_with(".dev") {
        (".outcode.dev", ".hive.dev")
    } else {
        (".outcode", ".hive")
    };
    let home = app.path().home_dir()?;
    let dir = home.join(name);
    let legacy = home.join(legacy);
    if !dir.exists() && legacy.is_dir() {
        let _ = std::fs::rename(&legacy, &dir);
    }
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}
