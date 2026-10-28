mod mock;
mod settings;

use tauri::Manager;
use tauri_plugin_window_state::StateFlags;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    // Geometry only: the saved file would otherwise also pin `decorations` and
    // visibility, so a later change to either in tauri.conf.json would be
    // overridden by whatever the last run left behind.
    .plugin(
      tauri_plugin_window_state::Builder::default()
        .with_state_flags(
          StateFlags::POSITION | StateFlags::SIZE | StateFlags::MAXIMIZED,
        )
        .build(),
    )
    .invoke_handler(tauri::generate_handler![
      mock::mock_run,
      settings::settings_get,
      settings::settings_update,
      settings::settings_reset,
      settings::settings_reload,
      settings::settings_path,
      settings::settings_reveal,
    ])
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      let data_dir = app.path().app_data_dir()?;
      app.manage(hive_store::SettingsFile::open(data_dir)?);
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
