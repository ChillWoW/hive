//! Chat commands over [`Engine`]. Watchers stream over Tauri channels; the
//! ones a webview opened are dropped when it reloads, since its channels die
//! with the page.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use outcode_engine::{Engine, WatchId};
use outcode_proto::{Chat, ChatsUpdate, MessagesUpdate};
use outcode_store::Store;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State, Webview};

use crate::settings::SettingsFile;

/// Opens the store under `data_dir`, closes turns a crash left open, and
/// starts the engine: Claude runs from `claude.binaryPath` (else found), and
/// closes after `chat.idleTimeoutMinutes` between prompts.
pub fn engine(app: &AppHandle, data_dir: &Path) -> Result<Engine, Box<dyn std::error::Error>> {
    let store = Store::open(data_dir)?;
    let closed = store.recover()?;
    if !closed.is_empty() {
        log::info!("closed {} turns left running", closed.len());
    }
    let settings = app.clone();
    let idle = app.clone();
    Ok(Engine::new(
        store,
        move |request| {
            let binary = settings.state::<SettingsFile>().get().claude.binary_path;
            let binary = (!binary.is_empty()).then(|| PathBuf::from(binary));
            outcode_harness::claude::run(request, binary.as_deref())
        },
        move || {
            let minutes = idle.state::<SettingsFile>().get().chat.idle_timeout_minutes;
            Duration::from_secs(u64::from(minutes) * 60)
        },
    ))
}

/// Watch ids by the webview that opened them.
#[derive(Default)]
pub struct Watches(Mutex<HashMap<String, Vec<WatchId>>>);

impl Watches {
    fn add(&self, webview: &Webview, id: WatchId) {
        self.0
            .lock()
            .unwrap()
            .entry(webview.label().to_owned())
            .or_default()
            .push(id);
    }

    fn remove(&self, id: WatchId) {
        for ids in self.0.lock().unwrap().values_mut() {
            ids.retain(|w| *w != id);
        }
    }

    /// Drops every watcher `label` opened.
    pub fn clear(&self, engine: &Engine, label: &str) {
        let ids = self.0.lock().unwrap().remove(label).unwrap_or_default();
        for id in ids {
            engine.unwatch(id);
        }
    }
}

fn err(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[tauri::command]
pub fn chat_create(engine: State<'_, Engine>, cwd: String) -> Result<Chat, String> {
    engine.create_chat(cwd).map_err(err)
}

/// Sends a prompt; the reply streams to the chat's message watchers.
#[tauri::command]
pub async fn chat_send(
    engine: State<'_, Engine>,
    chat_id: String,
    prompt: String,
) -> Result<(), String> {
    engine.send(&chat_id, prompt).map_err(err)
}

/// Stops the chat's running turn; its run stays up for the next prompt.
#[tauri::command]
pub fn chat_interrupt(engine: State<'_, Engine>, chat_id: String) {
    engine.interrupt(&chat_id);
}

/// A blank title clears it.
#[tauri::command]
pub fn chat_rename(
    engine: State<'_, Engine>,
    chat_id: String,
    title: Option<String>,
) -> Result<Chat, String> {
    engine.rename(&chat_id, title).map_err(err)
}

#[tauri::command]
pub fn chat_set_pinned(
    engine: State<'_, Engine>,
    chat_id: String,
    pinned: bool,
) -> Result<Chat, String> {
    engine.set_pinned(&chat_id, pinned).map_err(err)
}

#[tauri::command]
pub fn chat_set_archived(
    engine: State<'_, Engine>,
    chat_id: String,
    archived: bool,
) -> Result<Chat, String> {
    engine.set_archived(&chat_id, archived).map_err(err)
}

/// Deletes the chat and its transcript, stopping its agent.
#[tauri::command]
pub fn chat_delete(engine: State<'_, Engine>, chat_id: String) -> Result<(), String> {
    engine.delete_chat(&chat_id).map_err(err)
}

/// Every chat, then each change.
#[tauri::command]
pub fn chat_watch(
    webview: Webview,
    engine: State<'_, Engine>,
    watches: State<'_, Watches>,
    on_update: Channel<ChatsUpdate>,
) -> Result<WatchId, String> {
    let id = engine
        .watch_chats(move |u| on_update.send(u).is_ok())
        .map_err(err)?;
    watches.add(&webview, id);
    Ok(id)
}

/// A chat's messages, then each change.
#[tauri::command]
pub fn chat_watch_messages(
    webview: Webview,
    engine: State<'_, Engine>,
    watches: State<'_, Watches>,
    chat_id: String,
    on_update: Channel<MessagesUpdate>,
) -> Result<WatchId, String> {
    let id = engine
        .watch_messages(&chat_id, move |u| on_update.send(u).is_ok())
        .map_err(err)?;
    watches.add(&webview, id);
    Ok(id)
}

#[tauri::command]
pub fn chat_unwatch(engine: State<'_, Engine>, watches: State<'_, Watches>, id: WatchId) {
    engine.unwatch(id);
    watches.remove(id);
}
