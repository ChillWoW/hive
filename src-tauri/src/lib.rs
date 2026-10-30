mod attachments;
mod avatars;
mod editor;
mod engine;
mod files;
mod folders;
mod git;
mod html;
mod http;
mod mcp;
mod providers;
mod secrets;
mod settings;
mod terminals;
mod updater;
mod usage;

use std::sync::Arc;

use hive_engine::{Engine, EngineConfig};
use hive_harness::{ClaudeHarness, CodexHarness, Harness, MockHarness, OpencodeHarness};
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
    // Updates from GitHub Releases, installed when the user asks.
    .plugin(tauri_plugin_updater::Builder::new().build())
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
      secrets::answer_secret_request,
      html::answer_html_check,
      files::list_files,
      files::list_directory,
      files::rename_entry,
      files::delete_entry,
      editor::read_file,
      editor::read_file_bytes,
      editor::write_file,
      editor::open_file,
      folders::folder_icon,
      git::git_repo,
      git::git_switch_branch,
      git::git_create_branch,
      git::git_delete_branch,
      git::git_diff,
      git::git_turn_diff,
      git::git_history,
      git::git_search_history,
      git::git_fetch_all,
      git::git_commit_diff,
      avatars::git_avatars,
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
      settings::worktrees_default_dir,
      terminals::terminal_spawn,
      terminals::terminal_write,
      terminals::terminal_resize,
      terminals::terminal_kill,
      terminals::terminal_foreground,
      updater::update_check,
      updater::update_install,
      usage::usage_report,
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
      let data_dir = data_dir(app)?;
      let settings = hive_store::SettingsFile::open(&data_dir)?;
      // Resuming only happens at launch; titles follow the setting live.
      let initial = settings.get();
      let chats = initial.chats.clone();
      // Before the MCP host, whose `request_secret` reaches for it.
      let secrets = secrets::Secrets::new(&data_dir);
      secrets.sweep_every_hour();
      app.manage(secrets);
      app.manage(Arc::new(html::HtmlChecks::default()));
      let config = EngineConfig {
        resume_interrupted: chats.resume_interrupted,
        auto_title: chats.auto_title,
        worktrees_dir: data_dir.join("worktrees"),
        turn_snapshots_dir: data_dir.join("turn-snapshots"),
        mcp: mcp::start(app.handle(), &data_dir),
        ..EngineConfig::default()
      };
      app.manage(settings);
      app.manage(hive_usage::Usage::new(&data_dir));
      app.manage(avatars::Avatars::new(&data_dir));

      let harnesses: Vec<Arc<dyn Harness>> =
        vec![
          Arc::new(ClaudeHarness::new()),
          Arc::new(CodexHarness::new()),
          Arc::new(OpencodeHarness::new()),
          Arc::new(MockHarness::new()),
        ];
      let engine = Engine::new(
        hive_store::Store::open(&data_dir)?,
        harnesses,
        config,
        tauri::async_runtime::handle().inner().clone(),
      );
      // The worktree options and the rest the engine follows live.
      settings::apply(app.handle(), &engine, &initial);
      let recovery = engine.start()?;
      log::info!(
        "recovered: {} commands expired, {} turns aborted",
        recovery.expired_commands,
        recovery.aborted_messages.len()
      );
      // `apply` swept once; idle chats keep ageing while Hive stays open.
      let sweeper = engine.clone();
      tauri::async_runtime::spawn(async move {
        loop {
          tokio::time::sleep(std::time::Duration::from_secs(10 * 60)).await;
          if let Err(e) = sweeper.archive_stale() {
            log::warn!("auto-archiving chats: {e}");
          }
        }
      });
      app.manage(engine);
      app.manage(engine::Watches::default());
      app.manage(providers::SignIns::default());
      app.manage(terminals::Terminals::default());
      app.manage(updater::Updates::default());
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}

/// `~/.hive`, or `~/.hive.dev` for the dev config (`com.hive.dev`).
fn data_dir(app: &tauri::App) -> tauri::Result<std::path::PathBuf> {
  let name = if app.config().identifier.ends_with(".dev") {
    ".hive.dev"
  } else {
    ".hive"
  };
  let dir = app.path().home_dir()?.join(name);
  std::fs::create_dir_all(&dir)?;
  Ok(dir)
}
