mod attachments;
mod editor;
mod engine;
mod files;
mod folders;
mod git;
mod providers;
mod settings;
mod terminals;

use std::sync::Arc;

use hive_engine::{Engine, EngineConfig};
use hive_harness::{ClaudeHarness, CodexHarness, Harness, MockHarness};
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
    // Turns that finish or ask something while the window is in the background.
    .plugin(tauri_plugin_notification::init())
    .invoke_handler(tauri::generate_handler![
      attachments::save_attachment,
      attachments::attachment_bytes,
      attachments::open_attachment,
      engine::create_chat,
      engine::list_chats,
      engine::queue_command,
      engine::cancel_queued,
      engine::reorder_queue,
      engine::send_queued_now,
      engine::stop_background_task,
      engine::background_task_output,
      engine::watch_messages,
      engine::watch_chats,
      engine::unwatch,
      engine::list_harnesses,
      engine::list_commands,
      engine::update_chat_config,
      engine::rename_chat,
      engine::set_chat_archived,
      engine::set_chat_pinned,
      engine::mark_chat_seen,
      engine::delete_chat,
      files::list_files,
      files::list_directory,
      editor::read_file,
      editor::read_file_bytes,
      editor::write_file,
      editor::open_file,
      folders::folder_icon,
      git::git_repo,
      git::git_switch_branch,
      git::git_create_branch,
      git::git_delete_branch,
      providers::provider_status,
      providers::provider_usage,
      providers::provider_install,
      providers::provider_update,
      providers::provider_sign_in,
      providers::provider_finish_sign_in,
      providers::provider_cancel_sign_in,
      providers::provider_sign_out,
      settings::settings_get,
      settings::settings_update,
      settings::settings_reset,
      settings::settings_reload,
      settings::settings_path,
      settings::settings_reveal,
      terminals::terminal_spawn,
      terminals::terminal_write,
      terminals::terminal_resize,
      terminals::terminal_kill,
    ])
    // A reload takes the page's channels (and so its terminals) with it.
    .on_page_load(|webview, payload| {
      if payload.event() == PageLoadEvent::Started {
        let app = webview.app_handle();
        if let (Some(watches), Some(engine)) =
          (app.try_state::<engine::Watches>(), app.try_state::<Engine>())
        {
          watches.clear(&engine, webview.label());
        }
        if let Some(terminals) = app.try_state::<terminals::Terminals>() {
          terminals.clear(webview.label());
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
        worktrees_dir: data_dir.join("worktrees"),
        ..EngineConfig::default()
      };
      app.manage(settings);

      let harnesses: Vec<Arc<dyn Harness>> =
        vec![
          Arc::new(ClaudeHarness::new()),
          Arc::new(CodexHarness::new()),
          Arc::new(MockHarness::new()),
        ];
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
      app.manage(providers::SignIns::default());
      app.manage(terminals::Terminals::default());
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
