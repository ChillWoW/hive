mod chat;
mod files;
mod fonts;
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
            app.manage(themes::ThemesDir::open(data_dir.join("themes"))?);
            app.manage(updater::Updates::default());
            app.manage(chat::Chats::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            chat::chat_send,
            chat::chat_interrupt,
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
                let chats = app.state::<chat::Chats>();
                if chats.any() {
                    api.prevent_exit();
                    chats.close_all();
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
