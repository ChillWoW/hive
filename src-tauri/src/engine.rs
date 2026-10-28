//! Chat commands over `hive_engine::Engine`. Watchers stream over Tauri
//! channels; the ones a webview opened are dropped when it reloads, since
//! its channels die with the page.

use std::collections::HashMap;
use std::sync::Mutex;

use hive_engine::{Engine, WatchId};
use hive_proto::{
    Chat, ChatConfig, ChatsUpdate, Command, CommandPayload, HarnessCatalog, MessagesUpdate,
};
use tauri::ipc::Channel;
use tauri::{State, Webview};

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

#[tauri::command]
pub async fn create_chat(
    engine: State<'_, Engine>,
    cwd: String,
    config: ChatConfig,
) -> Result<Chat, String> {
    engine.create_chat(cwd, config).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_chats(engine: State<'_, Engine>) -> Result<Vec<Chat>, String> {
    engine.chats().map_err(|e| e.to_string())
}

/// Issues a command to a chat; returns it settled, or pending when it's a
/// prompt queued behind the running turn.
#[tauri::command]
pub async fn queue_command(
    engine: State<'_, Engine>,
    chat_id: String,
    payload: CommandPayload,
) -> Result<Command, String> {
    engine
        .queue_command(&chat_id, payload)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn watch_messages(
    webview: Webview,
    engine: State<'_, Engine>,
    watches: State<'_, Watches>,
    chat_id: String,
    on_update: Channel<MessagesUpdate>,
) -> Result<WatchId, String> {
    let id = engine
        .watch_messages(&chat_id, move |u| on_update.send(u).is_ok())
        .map_err(|e| e.to_string())?;
    watches.add(&webview, id);
    Ok(id)
}

#[tauri::command]
pub async fn watch_chats(
    webview: Webview,
    engine: State<'_, Engine>,
    watches: State<'_, Watches>,
    on_update: Channel<ChatsUpdate>,
) -> Result<WatchId, String> {
    let id = engine
        .watch_chats(move |u| on_update.send(u).is_ok())
        .map_err(|e| e.to_string())?;
    watches.add(&webview, id);
    Ok(id)
}

#[tauri::command]
pub async fn unwatch(
    engine: State<'_, Engine>,
    watches: State<'_, Watches>,
    id: WatchId,
) -> Result<(), String> {
    engine.unwatch(id);
    watches.remove(id);
    Ok(())
}

#[tauri::command]
pub async fn list_harnesses(engine: State<'_, Engine>) -> Result<Vec<HarnessCatalog>, String> {
    Ok(engine.catalogs())
}

/// Saves a chat's run settings; a live run picks them up from its next turn.
#[tauri::command]
pub async fn update_chat_config(
    engine: State<'_, Engine>,
    chat_id: String,
    config: ChatConfig,
) -> Result<Chat, String> {
    engine
        .update_config(&chat_id, config)
        .map_err(|e| e.to_string())
}

/// A blank title clears it; the chat is named again after its next turn.
#[tauri::command]
pub async fn rename_chat(
    engine: State<'_, Engine>,
    chat_id: String,
    title: Option<String>,
) -> Result<Chat, String> {
    engine
        .rename_chat(&chat_id, title)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_chat_archived(
    engine: State<'_, Engine>,
    chat_id: String,
    archived: bool,
) -> Result<Chat, String> {
    engine
        .set_archived(&chat_id, archived)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_chat_pinned(
    engine: State<'_, Engine>,
    chat_id: String,
    pinned: bool,
) -> Result<Chat, String> {
    engine
        .set_pinned(&chat_id, pinned)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn mark_chat_seen(engine: State<'_, Engine>, chat_id: String) -> Result<Chat, String> {
    engine.mark_seen(&chat_id).map_err(|e| e.to_string())
}

/// Deletes the chat and everything in it, stopping its run.
#[tauri::command]
pub async fn delete_chat(engine: State<'_, Engine>, chat_id: String) -> Result<(), String> {
    engine.delete_chat(&chat_id).map_err(|e| e.to_string())
}
