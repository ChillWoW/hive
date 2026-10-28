mod engine;
mod folders;
mod settings;

use std::sync::Arc;

use hive_engine::{Engine, EngineConfig};
use hive_harness::{ClaudeHarness, Harness, MockHarness};
use tauri::webview::PageLoadEvent;
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
    // The composer's folder picker.
    .plugin(tauri_plugin_dialog::init())
    // Markdown links open in the system browser, not the webview.
    .plugin(tauri_plugin_opener::init())
    .invoke_handler(tauri::generate_handler![
      engine::create_chat,
      engine::list_chats,
      engine::queue_command,
      engine::cancel_queued,
      engine::reorder_queue,
      engine::send_queued_now,
      engine::watch_messages,
      engine::watch_chats,
      engine::unwatch,
      engine::list_harnesses,
      engine::update_chat_config,
      engine::rename_chat,
      engine::set_chat_archived,
      engine::set_chat_pinned,
      engine::mark_chat_seen,
      engine::delete_chat,
      folders::folder_icon,
      settings::settings_get,
      settings::settings_update,
      settings::settings_reset,
      settings::settings_reload,
      settings::settings_path,
      settings::settings_reveal,
    ])
    // A reload takes the page's channels with it.
    .on_page_load(|webview, payload| {
      if payload.event() == PageLoadEvent::Started {
        let app = webview.app_handle();
        if let (Some(watches), Some(engine)) =
          (app.try_state::<engine::Watches>(), app.try_state::<Engine>())
        {
          watches.clear(&engine, webview.label());
        }
      }
    })
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      let data_dir = app.path().app_data_dir()?;
      let settings = hive_store::SettingsFile::open(&data_dir)?;
      // Resuming only happens at launch; titles follow the setting live.
      let chats = settings.get().chats;
      let config = EngineConfig {
        resume_interrupted: chats.resume_interrupted,
        auto_title: chats.auto_title,
        ..EngineConfig::default()
      };
      app.manage(settings);

      let harnesses: Vec<Arc<dyn Harness>> =
        vec![Arc::new(ClaudeHarness::new()), Arc::new(MockHarness::new())];
      let engine = Engine::new(
        hive_store::Store::open(&data_dir)?,
        harnesses,
        config,
        tauri::async_runtime::handle().inner().clone(),
      );
      let recovery = engine.start()?;
      log::info!(
        "recovered: {} commands expired, {} turns aborted",
        recovery.expired_commands,
        recovery.aborted_messages.len()
      );
      app.manage(engine);
      app.manage(engine::Watches::default());
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
