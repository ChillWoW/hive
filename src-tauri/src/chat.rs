//! Chat commands. Each chat keeps one live Claude run across prompts; its
//! events are broadcast as [`EVENT`], tagged with the chat's id.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use outcode_harness::RunHandle;
use outcode_proto::{AgentEvent, RunRequest};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::settings::SettingsFile;

const EVENT: &str = "chat://event";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChatEvent {
    chat_id: String,
    event: AgentEvent,
}

/// The chats' live runs.
#[derive(Default)]
pub struct Chats {
    runs: Mutex<HashMap<String, Live>>,
    next_id: AtomicU64,
}

struct Live {
    /// Tells this run from a later one of the same chat.
    id: u64,
    handle: RunHandle,
}

impl Chats {
    fn handle(&self, chat_id: &str) -> Option<RunHandle> {
        self.runs.lock().unwrap().get(chat_id).map(|live| live.handle.clone())
    }

    /// Whether any run is live.
    pub fn any(&self) -> bool {
        !self.runs.lock().unwrap().is_empty()
    }

    /// Closes every run: each one's stdin closes once no login refresh is in
    /// flight.
    pub fn close_all(&self) {
        for (_, live) in self.runs.lock().unwrap().drain() {
            live.handle.close();
        }
    }
}

/// Sends `request.prompt` to the chat's live run, starting one in
/// `request.cwd` when there's none. Its events follow as [`EVENT`]s, the
/// turn ending with `done`. Fails only when Claude can't be started.
#[tauri::command]
pub async fn chat_send(
    app: AppHandle,
    file: State<'_, SettingsFile>,
    chats: State<'_, Chats>,
    chat_id: String,
    request: RunRequest,
) -> Result<(), String> {
    if let Some(handle) = chats.handle(&chat_id)
        && handle.send(request.prompt.clone())
    {
        return Ok(());
    }

    let binary = file.get().claude.binary_path;
    let binary = (!binary.is_empty()).then(|| Path::new(&binary));
    let run = outcode_harness::claude::run(request, binary).map_err(|e| e.to_string())?;
    let id = chats.next_id.fetch_add(1, Ordering::Relaxed);
    chats.runs.lock().unwrap().insert(
        chat_id.clone(),
        Live {
            id,
            handle: run.handle,
        },
    );

    let mut events = run.events;
    tauri::async_runtime::spawn(async move {
        while let Some(event) = events.recv().await {
            let chat_id = chat_id.clone();
            let _ = app.emit(EVENT, ChatEvent { chat_id, event });
        }
        // The process exited: the next prompt starts a new run.
        let chats = app.state::<Chats>();
        let mut runs = chats.runs.lock().unwrap();
        if runs.get(&chat_id).is_some_and(|live| live.id == id) {
            runs.remove(&chat_id);
        }
    });
    Ok(())
}

/// Stops the chat's running turn; its run stays up for the next prompt.
#[tauri::command]
pub fn chat_interrupt(chats: State<'_, Chats>, chat_id: String) {
    if let Some(handle) = chats.handle(&chat_id) {
        handle.interrupt();
    }
}
