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
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
