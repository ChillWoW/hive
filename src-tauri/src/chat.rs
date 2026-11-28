//! Chat commands over [`Engine`]. Watchers stream over Tauri channels; the
//! ones a webview opened are dropped when it reloads, since its channels die
//! with the page.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use outcode_engine::{Engine, Hooks, SendMode, TextModel, TextUse, WatchId, WorktreeOptions};
use outcode_harness::Harness;
use outcode_harness::antigravity::{Antigravity, Options as AntigravityOptions};
use outcode_harness::codex::{Codex, Options as CodexOptions};
use outcode_harness::claude::{Claude, Options as ClaudeOptions};
use outcode_proto::{
    Attachment, Catalog, Chat, ChatConfig, ChatsUpdate, HandoffMode, HarnessId, InputResponse, MessagesUpdate, NewWorktree, SlashCommand,
    WorktreeStep,
};
use outcode_store::Store;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State, Webview};

use crate::settings::{BranchNaming, BusySend, SettingsFile};

/// Opens the store under `data_dir`, closes turns a crash left open, and
/// starts the engine: Claude runs from `claude.binaryPath` (else found),
/// Codex and Antigravity from wherever they're found; runs close after
/// `chat.idleTimeoutMinutes` between prompts; chats are titled by Claude's
/// `chat.textGenerationModel` while `chat.autoTitle` is on.
pub fn engine(app: &AppHandle, data_dir: &Path) -> Result<Engine, Box<dyn std::error::Error>> {
    let store = Store::open(data_dir)?;
    let closed = store.recover()?;
    if !closed.is_empty() {
        log::info!("closed {} turns left running", closed.len());
    }
    let (claude, codex, text, idle, worktrees) = (app.clone(), app.clone(), app.clone(), app.clone(), app.clone());
    let data_dir = data_dir.to_path_buf();
    let claude = Claude::new(move || {
        let all = claude.state::<SettingsFile>().get();
        let settings = all.claude;
        let window = settings.auto_compact_window;
        ClaudeOptions {
            binary: (!settings.binary_path.is_empty()).then(|| PathBuf::from(settings.binary_path)),
            auto_compact_window: (window != 0).then_some(window),
            prompt_suggestions: all.chat.prompt_suggestions,
        }
    });
    let codex = Codex::new(move || CodexOptions {
        prompt_suggestions: codex.state::<SettingsFile>().get().chat.prompt_suggestions,
        ..CodexOptions::default()
    });
    let antigravity = Antigravity::new(AntigravityOptions::default);
    Ok(Engine::new(
        store,
        Hooks {
            harnesses: vec![Arc::new(claude), Arc::new(codex), Arc::new(antigravity)],
            text_model: Box::new(move |purpose| {
                let chat = text.state::<SettingsFile>().get().chat;
                (purpose != TextUse::Title || chat.auto_title).then_some(TextModel {
                    harness: HarnessId::Claude,
                    model: chat.text_generation_model,
                })
            }),
            idle: Box::new(move || {
                let minutes = idle.state::<SettingsFile>().get().chat.idle_timeout_minutes;
                Duration::from_secs(u64::from(minutes) * 60)
            }),
            turn_snapshots: data_dir.join("turn-snapshots"),
            worktrees: Box::new(move || {
                let settings = worktrees.state::<SettingsFile>().get().worktrees;
                WorktreeOptions {
                    dir: worktrees_dir(&worktrees, &data_dir, &settings.location),
                    semantic: settings.branch_naming == BranchNaming::Semantic,
                    prefix: settings.branch_prefix,
                    delete_branch: settings.delete_branch,
                }
            }),
        },
    ))
}

/// `worktrees.location` with a leading `~` as the home folder, when that's
/// an absolute path; else `<data dir>/worktrees`.
fn worktrees_dir(app: &AppHandle, data_dir: &Path, location: &str) -> PathBuf {
    let home = app.path().home_dir().ok();
    let expanded = match (location.strip_prefix('~'), home) {
        (Some(rest), Some(home)) if rest.is_empty() || rest.starts_with(['/', '\\']) => {
            home.join(rest.trim_start_matches(['/', '\\']))
        }
        _ => PathBuf::from(location),
    };
    if !location.is_empty() && expanded.is_absolute() {
        expanded
    } else {
        default_worktrees_dir(data_dir)
    }
}

fn default_worktrees_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("worktrees")
}

/// Where worktrees go while `worktrees.location` is empty.
#[tauri::command]
pub fn worktrees_default_dir(dir: State<'_, DataDir>) -> String {
    default_worktrees_dir(&dir.0).to_string_lossy().into_owned()
}

/// The app's data folder (`~/.outcode`, or `~/.outcode.dev`).
pub struct DataDir(pub PathBuf);

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

/// With `worktree`, the chat works in a worktree of its own (`worktrees.*`
/// settings); `on_progress` hears each step of making it.
#[tauri::command]
pub async fn chat_create(
    engine: State<'_, Engine>,
    cwd: String,
    config: ChatConfig,
    worktree: Option<NewWorktree>,
    on_progress: Channel<WorktreeStep>,
) -> Result<Chat, String> {
    let Some(worktree) = worktree else {
        return engine.create_chat(cwd, config).map_err(err);
    };
    let progress = move |step| {
        let _ = on_progress.send(step);
    };
    engine
        .create_chat_in_worktree(cwd, config, worktree, progress)
        .await
        .map_err(err)
}

/// Sets what the chat runs on; a live run picks it up from the next prompt.
#[tauri::command]
pub fn chat_set_config(
    engine: State<'_, Engine>,
    chat_id: String,
    config: ChatConfig,
) -> Result<Chat, String> {
    engine.set_config(&chat_id, config).map_err(err)
}

/// Hands the chat to the agent `config` runs on, in the chat itself or a
/// new one; returns the chat that continues. Its next prompt carries a
/// summary of what came before.
#[tauri::command]
pub async fn chat_handoff(
    engine: State<'_, Engine>,
    chat_id: String,
    config: ChatConfig,
    mode: HandoffMode,
) -> Result<Chat, String> {
    engine.handoff(&chat_id, config, mode).await.map_err(err)
}

/// Forks the chat at `message_id` into a new one: the transcript up to that
/// message, on the same agent, folder and worktree. Returns the new chat.
#[tauri::command]
pub async fn chat_fork(engine: State<'_, Engine>, chat_id: String, message_id: String) -> Result<Chat, String> {
    engine.fork(&chat_id, &message_id).await.map_err(err)
}

/// `harness`'s models, and whether its CLI is installed.
#[tauri::command]
pub async fn harness_catalog(engine: State<'_, Engine>, harness: HarnessId) -> Result<Catalog, String> {
    Ok(harness_of(&engine, harness)?.catalog())
}

/// The commands and skills `harness` offers in `cwd` (a chat's run lists
/// its own in its session once it starts).
#[tauri::command]
pub async fn harness_commands(
    engine: State<'_, Engine>,
    harness: HarnessId,
    cwd: String,
) -> Result<Vec<SlashCommand>, String> {
    harness_of(&engine, harness)?.commands(&cwd).await.map_err(err)
}

fn harness_of(engine: &Engine, id: HarnessId) -> Result<Arc<dyn Harness>, String> {
    engine
        .harness(id)
        .cloned()
        .ok_or_else(|| format!("no {} harness", id.as_str()))
}

/// Sends a prompt with the files attached to it ([`attachment_save`]); the
/// reply streams to the chat's message watchers. While a turn runs it
/// waits in the chat's queue, or stops it after its running tool call or at
/// once (`chat.busySend`).
#[tauri::command]
pub async fn chat_send(
    app: AppHandle,
    engine: State<'_, Engine>,
    chat_id: String,
    prompt: String,
    attachments: Option<Vec<Attachment>>,
) -> Result<(), String> {
    let attachments = attachments.unwrap_or_default();
    if let Some(stray) = attachments
        .iter()
        .find(|a| !engine.store().is_attachment(Path::new(&a.path)))
    {
        return Err(format!("{} isn't an attachment", stray.path));
    }
    // `chat.busySend`: a prompt sent mid-turn waits, or stops the turn.
    let mode = match app.state::<SettingsFile>().get().chat.busy_send {
        BusySend::Queue => SendMode::Queue,
        BusySend::AfterTool => SendMode::AfterTool,
        BusySend::Interrupt => SendMode::Now,
    };
    engine.send_with(&chat_id, prompt, attachments, mode).map_err(err)
}

/// Stops the chat's running turn; its run stays up for the next prompt.
#[tauri::command]
pub fn chat_interrupt(engine: State<'_, Engine>, chat_id: String) {
    engine.interrupt(&chat_id);
}

/// Answers a question or approval the chat's turn waits on.
#[tauri::command]
pub fn chat_answer(
    engine: State<'_, Engine>,
    chat_id: String,
    request_id: String,
    response: InputResponse,
) -> Result<(), String> {
    engine.answer(&chat_id, &request_id, response).map_err(err)
}

/// Stops one of the chat's background tasks.
#[tauri::command]
pub fn chat_stop_task(engine: State<'_, Engine>, chat_id: String, task_id: String) -> Result<(), String> {
    engine.stop_task(&chat_id, &task_id).map_err(err)
}

#[tauri::command]
pub fn chat_queue_cancel(engine: State<'_, Engine>, chat_id: String, id: String) {
    engine.cancel_queued(&chat_id, &id);
}

/// Stops the running turn and sends the queued prompt `id` next.
#[tauri::command]
pub fn chat_queue_send_now(engine: State<'_, Engine>, chat_id: String, id: String) -> Result<(), String> {
    engine.send_queued_now(&chat_id, &id).map_err(err)
}

#[tauri::command]
pub fn chat_queue_reorder(engine: State<'_, Engine>, chat_id: String, ids: Vec<String>) {
    engine.reorder_queued(&chat_id, &ids);
}

/// Largest file that can be attached.
const MAX_ATTACHMENT_BYTES: usize = 32 * 1024 * 1024;

/// Keeps a copy of a file to send with a prompt; `data` is its base64.
#[tauri::command]
pub async fn attachment_save(engine: State<'_, Engine>, name: String, data: String) -> Result<Attachment, String> {
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.as_bytes())
        .map_err(err)?;
    if bytes.len() > MAX_ATTACHMENT_BYTES {
        return Err(format!("{name} is too big to attach (32 MB at most)."));
    }
    engine.store().save_attachment(&name, &bytes).map_err(err)
}

/// Copies a file on disk to send with a prompt.
#[tauri::command]
pub async fn attachment_add(engine: State<'_, Engine>, path: String) -> Result<Attachment, String> {
    let path = PathBuf::from(path);
    let meta = std::fs::metadata(&path).map_err(err)?;
    if !meta.is_file() {
        return Err(format!("{} isn't a file", path.display()));
    }
    if meta.len() as usize > MAX_ATTACHMENT_BYTES {
        return Err(format!("{} is too big to attach (32 MB at most).", path.display()));
    }
    let bytes = std::fs::read(&path).map_err(err)?;
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    engine.store().save_attachment(&name, &bytes).map_err(err)
}

/// An attachment's bytes as a `data:` URL, for previews.
#[tauri::command]
pub async fn attachment_data_url(engine: State<'_, Engine>, path: String, mime_type: String) -> Result<String, String> {
    use base64::Engine as _;
    if !engine.store().is_attachment(Path::new(&path)) {
        return Err(format!("{path} isn't an attachment"));
    }
    let bytes = std::fs::read(&path).map_err(err)?;
    Ok(format!(
        "data:{mime_type};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
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

/// Deletes the chat and its transcript, stopping its agent; its worktree
/// goes in the background.
#[tauri::command]
pub async fn chat_delete(engine: State<'_, Engine>, chat_id: String) -> Result<(), String> {
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
