mod chat;
mod claude;
mod codex;
mod files;
mod folders;
mod fonts;
mod git;
mod http;
mod mcp;
mod settings;
mod themes;
mod updater;

use std::path::PathBuf;

use outcode_engine::Engine;
use tauri::Manager;
use tauri::webview::PageLoadEvent;
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
        // A reload takes the page's channels (and so its watchers) with it.
        .on_page_load(|webview, payload| {
            if payload.event() == PageLoadEvent::Started {
                let app = webview.app_handle();
                if let (Some(watches), Some(engine)) =
                    (app.try_state::<chat::Watches>(), app.try_state::<Engine>())
                {
                    watches.clear(&engine, webview.label());
                }
            }
        })
        .setup(|app| {
            let data_dir = data_dir(app)?;
            let settings_file = settings::SettingsFile::open(&data_dir)?;
            claude::configure(&settings_file.get());
            app.manage(settings_file);
            app.manage(claude::SignIns::default());
            app.manage(claude::SignInResult::default());
            app.manage(codex::SignIns::default());
            app.manage(codex::SignInResult::default());
            app.manage(themes::ThemesDir::open(data_dir.join("themes"))?);
            app.manage(updater::Updates::default());
            let engine = chat::engine(app.handle(), &data_dir)?;
            app.manage(mcp::SecretRequests::default());
            mcp::start(app.handle(), &data_dir, &engine);
            app.manage(engine);
            app.manage(chat::Watches::default());
            app.manage(chat::DataDir(data_dir.clone()));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            chat::chat_create,
            chat::worktrees_default_dir,
            chat::chat_set_config,
            chat::harness_catalog,
            chat::chat_send,
            chat::chat_interrupt,
            chat::chat_answer,
            chat::chat_stop_task,
            chat::chat_queue_cancel,
            chat::chat_queue_send_now,
            chat::chat_queue_reorder,
            chat::harness_commands,
            chat::attachment_save,
            chat::attachment_add,
            chat::attachment_data_url,
            chat::chat_rename,
            mcp::secret_answer,
            claude::claude_status,
            claude::claude_sign_in_start,
            claude::claude_sign_in_wait,
            claude::claude_sign_in_code,
            claude::claude_sign_in_cancel,
            claude::claude_sign_out,
            claude::claude_update,
            claude::claude_install,
            claude::claude_latest_version,
            claude::claude_usage,
            codex::codex_status,
            codex::codex_sign_in_start,
            codex::codex_sign_in_wait,
            codex::codex_sign_in_cancel,
            codex::codex_sign_out,
            codex::codex_update,
            codex::codex_install,
            codex::codex_latest_version,
            codex::codex_usage,
            chat::chat_set_pinned,
            chat::chat_set_archived,
            chat::chat_delete,
            chat::chat_watch,
            chat::chat_watch_messages,
            chat::chat_unwatch,
            folders::folder_icon,
            git::git_repo,
            git::git_switch_branch,
            git::git_create_branch,
            git::git_delete_branch,
            files::file_open,
            settings::settings_get,
            settings::settings_update,
            settings::settings_reset,
            settings::settings_reload,
            settings::settings_path,
            settings::settings_reveal,
            fonts::fonts_list,
            themes::themes_list,
            themes::themes_open_dir,
            updater::update_check,
            updater::update_install,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // ⚠ Exiting closes Claude's stdin, and a CLI mid login refresh
            // then logs the user out: close the runs and wait it out first.
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                let engine = app.state::<Engine>();
                if engine.any_live() {
                    api.prevent_exit();
                    engine.close_all();
                    let app = app.clone();
                    tauri::async_runtime::spawn(async move {
                        outcode_harness::claude::settle_refresh().await;
                        app.exit(0);
                    });
                }
            }
        });
}

/// `~/.outcode`, or `~/.outcode.dev` for the dev config (`com.outcode.dev`).
fn data_dir(app: &tauri::App) -> tauri::Result<PathBuf> {
    let name = if app.config().identifier.ends_with(".dev") {
        ".outcode.dev"
    } else {
        ".outcode"
    };
    let dir = app.path().home_dir()?.join(name);
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}
