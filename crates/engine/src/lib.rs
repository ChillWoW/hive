//! hive-engine — runs chats.
//!
//! - Each chat has at most one live [`Run`]. The first prompt starts it
//!   (resuming the harness's own session when the chat has one); later
//!   prompts go to the same process. A run left idle for
//!   [`EngineConfig::idle_timeout`] is closed and the next prompt starts a
//!   fresh one.
//! - The UI acts through commands ([`Engine::queue_command`]): each is
//!   issued in the store's ledger, executed against the chat's run, and
//!   settled there. A prompt sent mid-turn waits in the chat's queue, held
//!   here rather than by the CLI so it can be reordered, withdrawn or sent
//!   now; it stays pending until its own turn starts, when the turn before
//!   it ends. A turn the user stops holds the queue until the next one ends.
//! - Every event is recorded through the store's turn (journal, fold,
//!   save) and sent to the chat's watchers, under one per-chat lock, so a
//!   watcher's snapshot and the updates after it never overlap or leave a
//!   gap. Background tasks are the exception: session state, kept on
//!   [`Session::background`] and never recorded. A run with background tasks
//!   is never closed for idling, and a config change waits for them. When
//!   one ends between turns the agent may start a turn by itself
//!   ([`AgentEvent::BackgroundTurn`]): a reply with no prompt, run like any
//!   other (status, queue, notifications).
//! - A secret the agent asks for (Hive's `request_secret` tool) is session
//!   state too: a card on [`Session::secrets`] while the tool call waits,
//!   for the turn that made it. The value never comes through here.
//!
//! [`Run`]: hive_harness::Run

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use hive_harness::{Harness, RunHandle};
use hive_proto::{
    AgentEvent, Attachment, BackgroundTask, Chat, ChatConfig, ChatsUpdate, Command,
    CommandPayload, CommandStatus, ContextUsage, DoneStatus, HarnessCatalog, HarnessId,
    McpServer, MessageStatus, MessagesUpdate, NewWorktree, RunRequest, SecretRequest, Session,
    SessionStatus, SlashCommand, TaskOutput, UserInputAnswer,
};
use hive_store::{new_id, now_ms, Recovery, Store, StoreError, Turn};
use tokio::sync::{mpsc, oneshot, watch};

mod titles;

pub use hive_store;

/// How long a file attached to a draft but never sent is kept: the app keeps
/// drafts across restarts.
const DRAFT_FILES_GRACE: Duration = Duration::from_secs(30 * 24 * 60 * 60);

/// Sent in place of the user when a turn Hive's exit cut short is resumed.
pub const RESUME_PROMPT: &str =
    "Hive closed while you were working on this. Pick up where you left off.";

#[derive(Debug, Clone)]
pub struct EngineConfig {
    /// How long a run may sit between turns before its process is closed.
    pub idle_timeout: Duration,
    /// At [`Engine::start`], send every turn that Hive's exit cut short back
    /// to its agent with [`RESUME_PROMPT`].
    pub resume_interrupted: bool,
    /// Name untitled chats with a title run; off, the first prompt's opening
    /// words name them. Changed live with [`Engine::set_auto_title`].
    pub auto_title: bool,
    /// Where chats' worktrees go, a folder each, unless `worktrees_location`
    /// says otherwise.
    pub worktrees_dir: PathBuf,
    /// The user's own place for worktrees, over `worktrees_dir`. Changed
    /// live with [`Engine::set_worktrees`].
    pub worktrees_location: Option<PathBuf>,
    /// New worktree branches are `<prefix>/<slug>`; empty, just the slug.
    /// Changed live with [`Engine::set_worktrees`].
    pub branch_prefix: String,
    /// Deleting a worktree chat deletes its branch too. Changed live with
    /// [`Engine::set_worktrees`].
    pub delete_worktree_branch: bool,
    /// Hive's own MCP server, given to every chat's runs with the chat's
    /// id ([`McpServer::for_chat`]). None runs agents without it.
    pub mcp: Option<McpServer>,
    /// Where the checkout snapshots taken as turns start keep their objects
    /// (the diff tab's "Latest turn"). Swept at [`Engine::start`].
    pub turn_snapshots_dir: PathBuf,
}

impl Default for EngineConfig {
    fn default() -> Self {
        Self {
            idle_timeout: Duration::from_secs(10 * 60),
            resume_interrupted: false,
            auto_title: true,
            worktrees_dir: std::env::temp_dir().join("hive-worktrees"),
            worktrees_location: None,
            branch_prefix: "hive".into(),
            delete_worktree_branch: false,
            mcp: None,
            turn_snapshots_dir: std::env::temp_dir().join("hive-turn-snapshots"),
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum EngineError {
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error("chat {0} not found")]
    ChatNotFound(String),
    #[error("That prompt is no longer queued.")]
    NotQueued,
    #[error("That background task has already ended.")]
    NoTask,
    #[error("{0}")]
    Task(String),
    #[error("Asking for a secret needs a turn in progress.")]
    NoTurn,
    #[error(transparent)]
    Git(#[from] hive_git::GitError),
}

pub type Result<T> = std::result::Result<T, EngineError>;

/// Identifies a watcher for [`Engine::unwatch`].
pub type WatchId = u64;

/// Receives a watcher's updates; returns false once nobody is listening,
/// which drops the watcher.
type Sink<T> = Box<dyn Fn(T) -> bool + Send + Sync>;

struct Watcher<T> {
    id: WatchId,
    sink: Sink<T>,
}

/// Sends `update` to every watcher, dropping the ones that went away.
fn publish<T: Clone>(watchers: &mut Vec<Watcher<T>>, update: T) {
    watchers.retain(|w| (w.sink)(update.clone()));
}

#[derive(Clone)]
pub struct Engine {
    inner: Arc<Inner>,
}

struct Inner {
    store: Store,
    harnesses: HashMap<HarnessId, Arc<dyn Harness>>,
    /// Registration order, which is the order pickers list them in.
    order: Vec<HarnessId>,
    config: EngineConfig,
    runtime: tokio::runtime::Handle,
    chats: Mutex<HashMap<String, Arc<ChatRuntime>>>,
    /// Lock order: a chat's state, then this; never the other way.
    list: Mutex<ChatList>,
    next_id: AtomicU64,
    /// Chats whose title is being written.
    titling: Mutex<HashSet<String>>,
    /// Starts as `config.auto_title`; follows the setting.
    auto_title: AtomicBool,
    /// Starts as `config.worktrees_location` / `branch_prefix` /
    /// `delete_worktree_branch`; follows the settings.
    worktrees: Mutex<WorktreeOptions>,
    /// How many runs' event loops are still going.
    pumps: Arc<watch::Sender<usize>>,
    /// Each chat's checkout as its latest prompted turn started, by chat id.
    /// In memory only: after a restart there's none until the next turn.
    turn_bases: Mutex<HashMap<String, watch::Receiver<TurnBase>>>,
}

struct WorktreeOptions {
    location: Option<PathBuf>,
    branch_prefix: String,
    delete_branch: bool,
}

/// A turn's starting snapshot, taken in the background.
enum TurnBase {
    Pending,
    /// None outside a checkout.
    Ready(Option<hive_git::TreeSnapshot>),
    Failed(String),
}

/// Held by a run's event loop; counts it in [`Inner::pumps`].
struct Pumping(Arc<watch::Sender<usize>>);

impl Pumping {
    fn new(pumps: &Arc<watch::Sender<usize>>) -> Self {
        pumps.send_modify(|n| *n += 1);
        Self(pumps.clone())
    }
}

impl Drop for Pumping {
    fn drop(&mut self) {
        self.0.send_modify(|n| *n -= 1);
    }
}

#[derive(Default)]
struct ChatList {
    watchers: Vec<Watcher<ChatsUpdate>>,
    /// Every live session, as last published.
    sessions: HashMap<String, Session>,
}

#[derive(Default)]
struct ChatRuntime {
    state: Mutex<ChatState>,
}

#[derive(Default)]
struct ChatState {
    run: Option<LiveRun>,
    /// The latest turn; kept after its `Done` so late subagent events still
    /// fold into it.
    turn: Option<Turn>,
    /// Prompts sent while a turn was in flight, next first.
    queued: VecDeque<Queued>,
    /// The in-flight turn was interrupted to run the queue's front next,
    /// so its end doesn't hold the queue.
    handover: bool,
    session: Option<Session>,
    /// The run's slash commands, kept for sessions created after they came.
    commands: Vec<SlashCommand>,
    /// The chat's config changed under the run: close it once its work is
    /// done, so the next prompt starts one with the new config.
    restart: bool,
    /// Secrets the running turn is waiting on, mirrored on the session.
    secrets: Vec<PendingSecret>,
    watchers: Vec<Watcher<MessagesUpdate>>,
}

/// A secret card. Dropping it (the turn ended, the run closed) wakes the
/// tool call waiting on it.
struct PendingSecret {
    request: SecretRequest,
    _ended: oneshot::Sender<()>,
}

impl ChatState {
    fn in_flight(&self) -> bool {
        self.turn
            .as_ref()
            .is_some_and(|t| t.assistant.status == Some(MessageStatus::Streaming))
    }

    fn background(&self) -> &[BackgroundTask] {
        self.session.as_ref().map_or(&[], |s| &s.background)
    }

    /// The run is doing something: a turn, or work left in the background.
    fn busy(&self) -> bool {
        self.in_flight() || !self.background().is_empty()
    }

    /// The run, if `task_id` is one of its background tasks.
    fn task_run(&self, task_id: &str) -> Result<&LiveRun> {
        self.run
            .as_ref()
            .filter(|_| self.background().iter().any(|t| t.id == task_id))
            .ok_or(EngineError::NoTask)
    }
}

struct LiveRun {
    id: u64,
    handle: RunHandle,
    /// `InputRequested` ids still waiting for an answer.
    inputs: HashSet<String>,
    /// Bumped by every event and command; an idle timer that finds it moved
    /// stands down.
    activity: u64,
}

/// A prompt on its way to the agent.
struct Prompt {
    text: String,
    attachments: Vec<Attachment>,
    /// The user message it becomes.
    message_id: String,
}

impl Prompt {
    fn paths(&self) -> Vec<String> {
        self.attachments.iter().map(|a| a.path.clone()).collect()
    }
}

struct Queued {
    command_id: String,
    prompt: Prompt,
}

enum Outcome {
    Applied,
    /// Handed to the run, waiting for its turn; settled when it starts.
    Queued,
    Rejected(String),
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl Engine {
    /// `runtime` runs the harnesses and the engine's own tasks.
    pub fn new(
        store: Store,
        harnesses: Vec<Arc<dyn Harness>>,
        config: EngineConfig,
        runtime: tokio::runtime::Handle,
    ) -> Self {
        Self {
            inner: Arc::new(Inner {
                store,
                order: harnesses.iter().map(|h| h.id()).collect(),
                harnesses: harnesses.into_iter().map(|h| (h.id(), h)).collect(),
                auto_title: AtomicBool::new(config.auto_title),
                worktrees: Mutex::new(WorktreeOptions {
                    location: config.worktrees_location.clone(),
                    branch_prefix: config.branch_prefix.clone(),
                    delete_branch: config.delete_worktree_branch,
                }),
                config,
                runtime,
                chats: Mutex::default(),
                list: Mutex::default(),
                next_id: AtomicU64::new(1),
                titling: Mutex::default(),
                pumps: Arc::new(watch::channel(0).0),
                turn_bases: Mutex::default(),
            }),
        }
    }

    pub fn store(&self) -> &Store {
        &self.inner.store
    }

    /// Turns title runs on or off for chats titled from now on.
    pub fn set_auto_title(&self, on: bool) {
        self.inner.auto_title.store(on, Ordering::Relaxed);
    }

    /// Where worktrees made from now on go (None: `config.worktrees_dir`),
    /// their branches' prefix, and whether deleting a worktree chat deletes
    /// its branch. Existing worktrees stay where they are.
    pub fn set_worktrees(
        &self,
        location: Option<PathBuf>,
        branch_prefix: String,
        delete_branch: bool,
    ) {
        *lock(&self.inner.worktrees) = WorktreeOptions {
            location,
            branch_prefix,
            delete_branch,
        };
    }

    /// Where new worktrees go when no location is set.
    pub fn default_worktrees_dir(&self) -> &Path {
        &self.inner.config.worktrees_dir
    }

    /// Run once at boot, before anything else: recovers what the last
    /// session left unfinished and, if configured, resumes it.
    pub fn start(&self) -> Result<Recovery> {
        let store = self.store();
        let recovery = store.recover()?;
        match store.sweep_attachments(DRAFT_FILES_GRACE) {
            Ok(0) => {}
            Ok(n) => log::info!("removed {n} unused attachments"),
            Err(e) => log::warn!("sweeping attachments: {e}"),
        }
        // Earlier runs' turn snapshots: unreachable now.
        let snapshots = self.inner.config.turn_snapshots_dir.clone();
        std::thread::spawn(move || hive_git::sweep_turn_snapshots(&snapshots));
        if !self.inner.config.resume_interrupted {
            return Ok(recovery);
        }
        let mut resumed = HashSet::new();
        for id in &recovery.aborted_messages {
            let Some(message) = store.message(id)? else {
                continue;
            };
            let chat_id = message.chat_id;
            let Some(chat) = store.chat(&chat_id)? else {
                continue;
            };
            // Only the chat's last turn, and only with a session to go back to.
            let last = store.messages(&chat_id)?.pop().map(|m| m.id);
            if chat.harness_session_id.is_none()
                || last.as_deref() != Some(id.as_str())
                || !resumed.insert(chat_id.clone())
            {
                continue;
            }
            let payload = CommandPayload::Send {
                prompt: RESUME_PROMPT.into(),
                message_id: new_id(),
                attachments: Vec::new(),
            };
            if let Err(e) = self.queue_command(&chat_id, payload) {
                log::warn!("resuming chat {chat_id}: {e}");
            }
        }
        Ok(recovery)
    }

    /// Stops every live run (turns interrupted, background tasks ended) and
    /// waits up to `grace` for the agents to exit. For when Hive is about to
    /// quit without running destructors (an update). Their turns stay
    /// unfinished in the store, so the next [`Engine::start`] recovers and,
    /// if configured, resumes them.
    pub async fn shutdown(&self, grace: Duration) {
        let chats: Vec<_> = lock(&self.inner.chats)
            .iter()
            .map(|(id, runtime)| (id.clone(), runtime.clone()))
            .collect();
        for (chat_id, runtime) in chats {
            let mut st = lock(&runtime.state);
            if let Some(run) = &st.run {
                // `close` alone lets the turn finish first.
                run.handle.interrupt();
            }
            self.end_run(&chat_id, &mut st);
        }
        let mut pumps = self.inner.pumps.subscribe();
        if tokio::time::timeout(grace, pumps.wait_for(|n| *n == 0))
            .await
            .is_err()
        {
            log::warn!("{} agents still running at shutdown", *pumps.borrow());
        }
    }

    // Chats

    pub fn create_chat(&self, cwd: impl Into<String>, config: ChatConfig) -> Result<Chat> {
        let chat = self.store().create_chat(cwd, config)?;
        publish(
            &mut lock(&self.inner.list).watchers,
            ChatsUpdate::Chat { chat: chat.clone() },
        );
        Ok(chat)
    }

    /// A chat in a worktree of its own: a new branch off `worktree.base`,
    /// checked out under [`EngineConfig::worktrees_dir`]. The chat keeps
    /// `cwd` as its project; its agent runs in the worktree.
    pub async fn create_chat_in_worktree(
        &self,
        cwd: impl Into<String>,
        config: ChatConfig,
        worktree: NewWorktree,
    ) -> Result<Chat> {
        let cwd = cwd.into();
        // Short, since the path shows in every tool call.
        let key: String = new_id()
            .chars()
            .filter(char::is_ascii_alphanumeric)
            .take(8)
            .collect();
        let (dir, prefix) = {
            let options = lock(&self.inner.worktrees);
            let root = options
                .location
                .as_ref()
                .unwrap_or(&self.inner.config.worktrees_dir);
            (root.join(key), options.branch_prefix.clone())
        };
        let made = hive_git::add_worktree(
            Path::new(&cwd),
            &dir,
            worktree.base.as_deref(),
            &prefix,
            worktree.hint.as_deref().unwrap_or_default(),
        )
        .await?;
        let saved = self.store().create_chat(cwd.clone(), config).and_then(|mut chat| {
            chat.worktree = Some(made.clone());
            self.store().save_chat(&chat)?;
            Ok(chat)
        });
        let chat = match saved {
            Ok(chat) => chat,
            Err(e) => {
                let _ = hive_git::remove_worktree(Path::new(&cwd), &made).await;
                return Err(e.into());
            }
        };
        publish(
            &mut lock(&self.inner.list).watchers,
            ChatsUpdate::Chat { chat: chat.clone() },
        );
        Ok(chat)
    }

    /// Most recently active first.
    pub fn chats(&self) -> Result<Vec<Chat>> {
        Ok(self.store().chats()?)
    }

    /// Every registered harness's catalog, in registration order.
    /// What `harness` would offer in `cwd` before a run reports its own
    /// commands ([`Harness::commands`]); none for an unknown harness.
    pub async fn commands(
        &self,
        harness: HarnessId,
        cwd: &str,
    ) -> std::result::Result<Vec<SlashCommand>, hive_harness::HarnessError> {
        match self.inner.harnesses.get(&harness) {
            Some(h) => h.commands(cwd).await,
            None => Ok(Vec::new()),
        }
    }

    pub fn catalogs(&self) -> Vec<HarnessCatalog> {
        self.inner
            .order
            .iter()
            .filter_map(|id| self.inner.harnesses.get(id))
            .map(|h| h.catalog())
            .collect()
    }

    /// Saves the chat's run settings. A live run keeps the ones it started
    /// with, so it's closed — now if idle, else once its work is done — and
    /// the next prompt starts a run that resumes the session with these.
    pub fn update_config(&self, chat_id: &str, config: ChatConfig) -> Result<Chat> {
        let runtime = self.runtime_for(chat_id);
        let mut st = lock(&runtime.state);
        let mut chat = self.chat(chat_id)?;
        if chat.config == config {
            return Ok(chat);
        }
        // Another CLI can't resume this one's session.
        if chat.config.harness != config.harness {
            chat.harness_session_id = None;
            chat.context = None;
        } else if chat.config.model != config.model {
            // Another model, another window; the next turn reports it.
            if let Some(context) = &mut chat.context {
                context.window = None;
            }
        }
        chat.config = config;
        self.store().save_chat(&chat)?;
        if st.run.is_some() {
            if st.busy() {
                st.restart = true;
            } else {
                self.end_run(chat_id, &mut st);
            }
        }
        publish(
            &mut lock(&self.inner.list).watchers,
            ChatsUpdate::Chat { chat: chat.clone() },
        );
        Ok(chat)
    }

    /// Names the chat; a blank title clears it, and the next completed turn
    /// names it again.
    pub fn rename_chat(&self, chat_id: &str, title: Option<String>) -> Result<Chat> {
        let title = title.map(|t| t.trim().to_owned()).filter(|t| !t.is_empty());
        self.edit_chat(chat_id, |chat| chat.title = title)
    }

    /// Archiving unpins.
    pub fn set_archived(&self, chat_id: &str, archived: bool) -> Result<Chat> {
        self.edit_chat(chat_id, |chat| {
            chat.archived = archived;
            if archived {
                chat.pinned_at = None;
            }
        })
    }

    /// Pinning unarchives; a chat already pinned keeps its place.
    pub fn set_pinned(&self, chat_id: &str, pinned: bool) -> Result<Chat> {
        self.edit_chat(chat_id, |chat| {
            if !pinned {
                chat.pinned_at = None;
            } else if chat.pinned_at.is_none() {
                chat.pinned_at = Some(now_ms());
                chat.archived = false;
            }
        })
    }

    /// The user has seen everything in the chat so far, which clears its
    /// unread dot.
    pub fn mark_seen(&self, chat_id: &str) -> Result<Chat> {
        self.edit_chat(chat_id, |chat| {
            if chat.unseen() {
                chat.last_seen_at = Some(now_ms().max(chat.last_message_at.unwrap_or(0)));
            }
        })
    }

    /// Deletes the chat with its transcript, journal and commands, closing
    /// its run first. Its worktree is removed in the background, once the
    /// run has let go of it. The worktree's branch is kept, unless the
    /// delete-branch option is on and the worktree went.
    pub fn delete_chat(&self, chat_id: &str) -> Result<()> {
        let runtime = self.runtime_for(chat_id);
        let mut st = lock(&runtime.state);
        let chat = self.chat(chat_id)?;
        self.end_run(chat_id, &mut st);
        st.turn = None;
        st.queued.clear();
        // Their chat is gone; nothing more will come.
        st.watchers.clear();
        self.store().delete_chat(chat_id)?;
        lock(&self.inner.chats).remove(chat_id);
        lock(&self.inner.turn_bases).remove(chat_id);
        publish(
            &mut lock(&self.inner.list).watchers,
            ChatsUpdate::Removed {
                chat_id: chat_id.to_owned(),
            },
        );
        if let Some(worktree) = chat.worktree {
            let delete_branch = lock(&self.inner.worktrees).delete_branch;
            self.inner.runtime.spawn(async move {
                let cwd = Path::new(&chat.cwd);
                if let Err(e) = hive_git::remove_worktree(cwd, &worktree).await {
                    log::warn!("removing worktree {}: {e}", worktree.root);
                } else if delete_branch && cwd.is_dir() {
                    if let Err(e) = hive_git::delete(cwd, &worktree.branch).await {
                        log::warn!("deleting branch {}: {e}", worktree.branch);
                    }
                }
            });
        }
        Ok(())
    }

    /// Stops one of the chat's background tasks. The session's task list
    /// drops it once the agent reports it stopped.
    pub fn stop_background_task(&self, chat_id: &str, task_id: &str) -> Result<()> {
        let runtime = self.runtime_for(chat_id);
        let st = lock(&runtime.state);
        self.chat(chat_id)?;
        st.task_run(task_id)?.handle.stop_task(task_id);
        Ok(())
    }

    /// The end of a background shell's output.
    pub async fn background_task_output(&self, chat_id: &str, task_id: &str) -> Result<TaskOutput> {
        let handle = {
            let runtime = self.runtime_for(chat_id);
            let st = lock(&runtime.state);
            self.chat(chat_id)?;
            st.task_run(task_id)?.handle.clone()
        };
        handle.task_output(task_id).await.map_err(EngineError::Task)
    }

    /// Puts up a card asking the user for a secret, for an agent's tool call
    /// waiting on it. Only during a turn: the card goes when the turn ends,
    /// the run closes or the chat is deleted, and then the returned receiver
    /// resolves (with an error), unless [`Engine::close_secret_request`]
    /// took the card down first. The chat waits on input while it's up.
    pub fn open_secret_request(
        &self,
        chat_id: &str,
        request: SecretRequest,
    ) -> Result<oneshot::Receiver<()>> {
        let runtime = self.runtime_for(chat_id);
        let mut st = lock(&runtime.state);
        self.chat(chat_id)?;
        if st.run.is_none() || !st.in_flight() {
            return Err(EngineError::NoTurn);
        }
        let (ended, rx) = oneshot::channel();
        st.secrets.push(PendingSecret {
            request,
            _ended: ended,
        });
        self.sync_secrets(chat_id, &mut st);
        Ok(rx)
    }

    /// Takes a secret card down: answered, declined or given up on.
    pub fn close_secret_request(&self, chat_id: &str, request_id: &str) {
        let Some(runtime) = lock(&self.inner.chats).get(chat_id).cloned() else {
            return;
        };
        let mut st = lock(&runtime.state);
        let before = st.secrets.len();
        st.secrets.retain(|p| p.request.id != request_id);
        if st.secrets.len() != before {
            self.sync_secrets(chat_id, &mut st);
        }
    }

    /// Mirrors the pending secrets on the session; during a turn the chat
    /// waits on input while there's a secret or a question.
    fn sync_secrets(&self, chat_id: &str, st: &mut ChatState) {
        let requests: Vec<SecretRequest> = st.secrets.iter().map(|p| p.request.clone()).collect();
        let waiting =
            !requests.is_empty() || st.run.as_ref().is_some_and(|r| !r.inputs.is_empty());
        let in_flight = st.in_flight();
        let Some(session) = &mut st.session else {
            return;
        };
        let mut changed = session.secrets != requests;
        session.secrets = requests;
        if in_flight {
            let status = if waiting {
                SessionStatus::AwaitingInput
            } else {
                SessionStatus::Working
            };
            changed |= session.status != status;
            session.status = status;
        }
        if changed {
            session.updated_at = now_ms();
            let session = session.clone();
            self.publish_session(chat_id, Some(session));
        }
    }

    /// Changes the chat under its lock, publishing it if anything changed.
    fn edit_chat(&self, chat_id: &str, edit: impl FnOnce(&mut Chat)) -> Result<Chat> {
        let runtime = self.runtime_for(chat_id);
        let _st = lock(&runtime.state);
        let before = self.chat(chat_id)?;
        let chat = self.store().update_chat(chat_id, edit)?;
        if chat != before {
            publish(
                &mut lock(&self.inner.list).watchers,
                ChatsUpdate::Chat { chat: chat.clone() },
            );
        }
        Ok(chat)
    }

    fn chat(&self, id: &str) -> Result<Chat> {
        self.store()
            .chat(id)?
            .ok_or_else(|| EngineError::ChatNotFound(id.to_owned()))
    }

    fn runtime_for(&self, chat_id: &str) -> Arc<ChatRuntime> {
        lock(&self.inner.chats)
            .entry(chat_id.to_owned())
            .or_default()
            .clone()
    }

    // Watchers

    /// Streams `chat_id`'s transcript into `sink`: a snapshot, then every
    /// update until [`Engine::unwatch`] or the sink returns false.
    pub fn watch_messages(
        &self,
        chat_id: &str,
        sink: impl Fn(MessagesUpdate) -> bool + Send + Sync + 'static,
    ) -> Result<WatchId> {
        self.chat(chat_id)?;
        let id = self.next_id();
        let runtime = self.runtime_for(chat_id);
        let mut st = lock(&runtime.state);
        let mut messages = self.store().messages(chat_id)?;
        // The store saves a streaming reply at most once a second; the live
        // turn has everything folded so far.
        if let Some(turn) = &st.turn {
            if let Some(m) = messages.iter_mut().find(|m| m.id == turn.assistant.id) {
                *m = turn.assistant.clone();
            }
        }
        let mut pending: Vec<Command> = self
            .store()
            .commands(chat_id)?
            .into_iter()
            .filter(|c| c.status == CommandStatus::Pending)
            .collect();
        pending.sort_by_key(|c| {
            st.queued
                .iter()
                .position(|q| q.command_id == c.id)
                .unwrap_or(usize::MAX)
        });
        if sink(MessagesUpdate::Snapshot { messages, pending }) {
            st.watchers.push(Watcher {
                id,
                sink: Box::new(sink),
            });
        }
        Ok(id)
    }

    /// Streams the chat list and live sessions into `sink`.
    pub fn watch_chats(
        &self,
        sink: impl Fn(ChatsUpdate) -> bool + Send + Sync + 'static,
    ) -> Result<WatchId> {
        let id = self.next_id();
        let mut list = lock(&self.inner.list);
        let chats = self.store().chats()?;
        let sessions = list.sessions.values().cloned().collect();
        if sink(ChatsUpdate::Snapshot { chats, sessions }) {
            list.watchers.push(Watcher {
                id,
                sink: Box::new(sink),
            });
        }
        Ok(id)
    }

    pub fn unwatch(&self, id: WatchId) {
        lock(&self.inner.list).watchers.retain(|w| w.id != id);
        let runtimes: Vec<_> = lock(&self.inner.chats).values().cloned().collect();
        for runtime in runtimes {
            lock(&runtime.state).watchers.retain(|w| w.id != id);
        }
    }

    fn next_id(&self) -> u64 {
        self.inner.next_id.fetch_add(1, Ordering::Relaxed)
    }

    // Commands

    /// Issues `payload` to the chat and executes it. Returns the command as
    /// settled, or still pending for a prompt queued behind a running turn.
    pub fn queue_command(&self, chat_id: &str, payload: CommandPayload) -> Result<Command> {
        let chat = self.chat(chat_id)?;
        let runtime = self.runtime_for(chat_id);
        let mut st = lock(&runtime.state);
        let store = self.store();

        let command = store.issue_command(chat_id, payload.clone())?;
        publish(
            &mut st.watchers,
            MessagesUpdate::Command {
                command: command.clone(),
            },
        );
        if let Some(run) = &mut st.run {
            run.activity += 1;
        }

        let outcome = match payload {
            CommandPayload::Send {
                prompt,
                message_id,
                attachments,
            } => {
                let prompt = Prompt {
                    text: prompt,
                    attachments,
                    message_id,
                };
                self.send(&chat, &runtime, &mut st, &command.id, prompt)
            }
            CommandPayload::Answer {
                request_id,
                answers,
            } => Ok(answer(&mut st, request_id, answers)),
            CommandPayload::Interrupt => Ok(interrupt(&st)),
        }
        .unwrap_or_else(|e| Outcome::Rejected(e.to_string()));

        let (status, resolution) = match outcome {
            Outcome::Queued => return Ok(command),
            Outcome::Applied => (CommandStatus::Applied, None),
            Outcome::Rejected(reason) => (CommandStatus::Rejected, Some(reason)),
        };
        let command = store.resolve_command(&command.id, status, resolution)?;
        publish(
            &mut st.watchers,
            MessagesUpdate::Command {
                command: command.clone(),
            },
        );
        Ok(command)
    }

    fn send(
        &self,
        chat: &Chat,
        runtime: &Arc<ChatRuntime>,
        st: &mut ChatState,
        command_id: &str,
        prompt: Prompt,
    ) -> Result<Outcome> {
        if !prompt.attachments.is_empty() {
            let takes_files = self
                .inner
                .harnesses
                .get(&chat.config.harness)
                .is_some_and(|h| h.catalog().capabilities.attachments);
            if !takes_files {
                return Ok(Outcome::Rejected(
                    "This agent can't take attachments.".into(),
                ));
            }
        }
        if st.in_flight() {
            st.queued.push_back(Queued {
                command_id: command_id.to_owned(),
                prompt,
            });
            return Ok(Outcome::Queued);
        }
        self.dispatch(chat, runtime, st, prompt)
    }

    /// Starts a turn with `prompt` now, starting a run first if there's none.
    fn dispatch(
        &self,
        chat: &Chat,
        runtime: &Arc<ChatRuntime>,
        st: &mut ChatState,
        prompt: Prompt,
    ) -> Result<Outcome> {
        // A config change was waiting on background work; this prompt
        // starts a run with the new config, ending that work.
        if st.restart {
            self.end_run(&chat.id, st);
        }
        if st.run.is_none() {
            return self.start_run(chat, runtime, st, prompt);
        }
        self.start_turn(&chat.id, st, &prompt)?;
        self.snapshot_turn(chat);
        if let Some(run) = &st.run {
            run.handle.send_with(prompt.text.clone(), prompt.paths());
        }
        self.set_status(&chat.id, st, SessionStatus::Working);
        Ok(Outcome::Applied)
    }

    // The queue

    /// Withdraws a prompt still waiting in the chat's queue.
    pub fn cancel_queued(&self, chat_id: &str, command_id: &str) -> Result<Command> {
        let runtime = self.runtime_for(chat_id);
        let mut st = lock(&runtime.state);
        self.chat(chat_id)?;
        let q = take_queued(&mut st, command_id)?;
        let command =
            self.store()
                .resolve_command(&q.command_id, CommandStatus::Cancelled, None)?;
        publish(
            &mut st.watchers,
            MessagesUpdate::Command {
                command: command.clone(),
            },
        );
        Ok(command)
    }

    /// Reorders the queue: the listed command ids first, in that order, then
    /// any others where they were.
    pub fn reorder_queue(&self, chat_id: &str, command_ids: &[String]) -> Result<()> {
        let runtime = self.runtime_for(chat_id);
        let mut st = lock(&runtime.state);
        self.chat(chat_id)?;
        let mut rest: Vec<Queued> = st.queued.drain(..).collect();
        let mut ordered = VecDeque::with_capacity(rest.len());
        for id in command_ids {
            if let Some(i) = rest.iter().position(|q| &q.command_id == id) {
                ordered.push_back(rest.remove(i));
            }
        }
        ordered.extend(rest);
        st.queued = ordered;
        self.publish_queue(&mut st);
        Ok(())
    }

    /// Runs a queued prompt next: now if nothing is running, else by
    /// interrupting the running turn.
    pub fn send_queued_now(&self, chat_id: &str, command_id: &str) -> Result<()> {
        let runtime = self.runtime_for(chat_id);
        let mut st = lock(&runtime.state);
        self.chat(chat_id)?;
        let q = take_queued(&mut st, command_id)?;
        if !st.in_flight() {
            self.start_queued(chat_id, &runtime, &mut st, q);
            return Ok(());
        }
        st.queued.push_front(q);
        self.publish_queue(&mut st);
        st.handover = true;
        if let Some(run) = &mut st.run {
            run.activity += 1;
            run.handle.interrupt();
        }
        Ok(())
    }

    /// Starts the queue's front, rejecting prompts that can't start. False
    /// if none did.
    fn advance_queue(&self, chat_id: &str, runtime: &Arc<ChatRuntime>, st: &mut ChatState) -> bool {
        while let Some(q) = st.queued.pop_front() {
            if self.start_queued(chat_id, runtime, st, q) {
                return true;
            }
        }
        false
    }

    /// Starts a turn for a queued prompt and settles its command.
    fn start_queued(
        &self,
        chat_id: &str,
        runtime: &Arc<ChatRuntime>,
        st: &mut ChatState,
        q: Queued,
    ) -> bool {
        let outcome = self
            .chat(chat_id)
            .and_then(|chat| self.dispatch(&chat, runtime, st, q.prompt));
        let (status, resolution) = match outcome {
            Ok(Outcome::Applied) => (CommandStatus::Applied, None),
            Ok(Outcome::Rejected(reason)) => (CommandStatus::Rejected, Some(reason)),
            Ok(Outcome::Queued) => unreachable!("dispatch never queues"),
            Err(e) => (CommandStatus::Rejected, Some(e.to_string())),
        };
        self.settle_queued(st, &q.command_id, status, resolution);
        status == CommandStatus::Applied
    }

    fn publish_queue(&self, st: &mut ChatState) {
        let command_ids = st.queued.iter().map(|q| q.command_id.clone()).collect();
        publish(&mut st.watchers, MessagesUpdate::Queue { command_ids });
    }

    fn start_run(
        &self,
        chat: &Chat,
        runtime: &Arc<ChatRuntime>,
        st: &mut ChatState,
        prompt: Prompt,
    ) -> Result<Outcome> {
        let Some(harness) = self.inner.harnesses.get(&chat.config.harness) else {
            return Ok(Outcome::Rejected(format!(
                "Hive can't run {:?} chats yet.",
                chat.config.harness
            )));
        };
        // Its folder may have been deleted since; bring it back first.
        if let Some(worktree) = &chat.worktree {
            match hive_git::restore_worktree(Path::new(&chat.cwd), worktree) {
                Ok(true) => log::info!("restored worktree {}", worktree.root),
                Ok(false) => {}
                Err(e) => {
                    return Ok(Outcome::Rejected(format!(
                        "The chat's worktree is missing and couldn't be restored: {e}"
                    )))
                }
            }
        }
        let config = &chat.config;
        let request = RunRequest {
            harness: config.harness,
            prompt: prompt.text.clone(),
            cwd: chat.work_dir().to_owned(),
            sandbox: config.sandbox,
            model: config.model.clone(),
            reasoning: config.reasoning,
            model_options: config.model_options.clone(),
            auto_approve: false,
            access: config.access,
            plan: config.plan,
            resume: chat.harness_session_id.clone(),
            attachments: prompt.paths(),
            mcp: self.inner.config.mcp.as_ref().map(|m| m.for_chat(&chat.id)),
        };
        let run = {
            let _runtime = self.inner.runtime.enter();
            match harness.run(request) {
                Ok(run) => run,
                Err(e) => return Ok(Outcome::Rejected(e.to_string())),
            }
        };
        if let Err(e) = self.start_turn(&chat.id, st, &prompt) {
            run.handle.close();
            return Err(e);
        }
        self.snapshot_turn(chat);
        let id = self.next_id();
        st.run = Some(LiveRun {
            id,
            handle: run.handle,
            inputs: HashSet::new(),
            activity: 0,
        });
        // Counted before it's spawned, so `shutdown` can't miss it.
        let pumping = Pumping::new(&self.inner.pumps);
        let pump = self
            .clone()
            .pump(chat.id.clone(), runtime.clone(), id, run.events);
        self.inner.runtime.spawn(async move {
            let _pumping = pumping;
            pump.await;
        });
        self.set_status(&chat.id, st, SessionStatus::Working);
        Ok(Outcome::Applied)
    }

    /// Saves the prompt and an empty reply, and makes it the live turn.
    fn start_turn(
        &self,
        chat_id: &str,
        st: &mut ChatState,
        prompt: &Prompt,
    ) -> Result<()> {
        let store = self.store();
        if let Some(previous) = &mut st.turn {
            store.flush(previous)?;
        }
        let turn = store.start_turn(
            chat_id,
            &prompt.text,
            &prompt.attachments,
            Some(prompt.message_id.clone()),
        )?;
        self.begin_turn(chat_id, st, turn);
        Ok(())
    }

    /// Snapshots the chat's checkout in the background as a prompt starts a
    /// turn: the base of its "Latest turn" diff ([`Engine::turn_diff`]), as
    /// in zeron. Best-effort, and racing the agent's first edits.
    fn snapshot_turn(&self, chat: &Chat) {
        let (tx, rx) = watch::channel(TurnBase::Pending);
        lock(&self.inner.turn_bases).insert(chat.id.clone(), rx);
        let cwd = PathBuf::from(chat.work_dir());
        let dir = self.inner.config.turn_snapshots_dir.clone();
        let chat_id = chat.id.clone();
        self.inner.runtime.spawn(async move {
            let base = match hive_git::snapshot_tree(&cwd, &dir).await {
                Ok(snapshot) => TurnBase::Ready(snapshot),
                Err(e) => {
                    log::warn!("snapshotting {chat_id}'s turn: {e}");
                    TurnBase::Failed(e.to_string())
                }
            };
            // Nobody listening: a later turn replaced it, or the chat went.
            let _ = tx.send(base);
        });
    }

    /// What the chat's latest prompted turn changed in its checkout so far:
    /// the snapshot taken as it started against the checkout now. None
    /// before a turn since launch, or outside a checkout.
    pub async fn turn_diff(&self, chat_id: &str) -> Result<Option<hive_proto::GitDiff>> {
        self.chat(chat_id)?;
        let Some(mut base) = lock(&self.inner.turn_bases).get(chat_id).cloned() else {
            return Ok(None);
        };
        let turn = {
            let Ok(ready) = base.wait_for(|b| !matches!(b, TurnBase::Pending)).await else {
                return Ok(None);
            };
            match &*ready {
                TurnBase::Ready(Some(snapshot)) => snapshot.clone(),
                TurnBase::Ready(None) | TurnBase::Pending => return Ok(None),
                TurnBase::Failed(e) => return Err(hive_git::GitError::Failed(e.clone()).into()),
            }
        };
        Ok(Some(hive_git::turn_diff(&turn).await?))
    }

    /// Opens a reply with no prompt: the agent started a turn on its own.
    fn start_reply(&self, chat_id: &str, st: &mut ChatState) -> Result<()> {
        let store = self.store();
        if let Some(previous) = &mut st.turn {
            store.flush(previous)?;
        }
        let turn = store.start_reply(chat_id)?;
        self.begin_turn(chat_id, st, turn);
        Ok(())
    }

    /// Makes `turn` the live one and shows its messages.
    fn begin_turn(&self, chat_id: &str, st: &mut ChatState, turn: Turn) {
        for message in turn.user.iter().chain([&turn.assistant]) {
            publish(
                &mut st.watchers,
                MessagesUpdate::Message {
                    message: message.clone(),
                },
            );
        }
        st.turn = Some(turn);
        self.publish_chat(chat_id);
    }

    // Events

    /// Feeds a run's events into the chat until the process exits.
    async fn pump(
        self,
        chat_id: String,
        runtime: Arc<ChatRuntime>,
        run_id: u64,
        mut events: mpsc::Receiver<AgentEvent>,
    ) {
        while let Some(event) = events.recv().await {
            let mut st = lock(&runtime.state);
            // A closed run's stragglers.
            if st.run.as_ref().map(|r| r.id) != Some(run_id) {
                continue;
            }
            self.handle_event(&chat_id, &runtime, &mut st, event);
        }
        let mut st = lock(&runtime.state);
        if st.run.as_ref().map(|r| r.id) != Some(run_id) {
            return;
        }
        // Taken first, so the closing `Done` doesn't hand them to the dead run.
        let queued: Vec<_> = st.queued.drain(..).collect();
        if st.in_flight() {
            let done = AgentEvent::Done {
                status: DoneStatus::Errored,
                error: Some("The agent exited before the turn finished.".into()),
                session_id: None,
            };
            self.handle_event(&chat_id, &runtime, &mut st, done);
        }
        for q in queued {
            self.settle_queued(
                &mut st,
                &q.command_id,
                CommandStatus::Rejected,
                Some("The agent exited before this prompt ran.".into()),
            );
        }
        self.end_run(&chat_id, &mut st);
    }

    fn handle_event(
        &self,
        chat_id: &str,
        runtime: &Arc<ChatRuntime>,
        st: &mut ChatState,
        event: AgentEvent,
    ) {
        let store = self.store();
        if let AgentEvent::BackgroundTasks { tasks } = event {
            if let Some(run) = &mut st.run {
                run.activity += 1;
            }
            self.set_background(chat_id, runtime, st, tasks);
            return;
        }
        if let Some(run) = &mut st.run {
            run.activity += 1;
            match &event {
                AgentEvent::InputRequested { request_id, .. } => {
                    run.inputs.insert(request_id.clone());
                }
                AgentEvent::InputResolved { request_id } => {
                    run.inputs.remove(request_id);
                }
                AgentEvent::Done { .. } => run.inputs.clear(),
                _ => {}
            }
        }

        // Background work ended between turns and the agent took it up by
        // itself: a reply of its own, which the turn's `Done` ends as usual.
        if matches!(event, AgentEvent::BackgroundTurn { .. }) && !st.in_flight() {
            if let Err(e) = self.start_reply(chat_id, st) {
                log::warn!("chat {chat_id}: starting a reply: {e}");
                return;
            }
            self.set_status(chat_id, st, SessionStatus::Working);
        }

        let Some(turn) = &mut st.turn else {
            return;
        };
        if let Err(e) = store.record(turn, &event) {
            log::warn!("chat {chat_id}: recording an event: {e}");
        }
        let message_id = turn.assistant.id.clone();
        let finished = matches!(event, AgentEvent::Done { .. }).then(|| turn.assistant.clone());
        publish(
            &mut st.watchers,
            MessagesUpdate::Event {
                message_id,
                event: event.clone(),
            },
        );

        match event {
            AgentEvent::SessionStarted { .. } => self.publish_chat(chat_id),
            AgentEvent::InputRequested { .. } => {
                self.set_status(chat_id, st, SessionStatus::AwaitingInput)
            }
            AgentEvent::InputResolved { .. }
                if st.run.as_ref().is_some_and(|r| r.inputs.is_empty())
                    && st.secrets.is_empty() =>
            {
                self.set_status(chat_id, st, SessionStatus::Working)
            }
            AgentEvent::ContextUsage { tokens, window } => {
                // On the chat, so the ring outlives the run.
                let mut changed = false;
                let edited = self.store().update_chat(chat_id, |chat| {
                    let before = chat.context;
                    let context = chat.context.get_or_insert_with(ContextUsage::default);
                    context.tokens = tokens.or(context.tokens);
                    context.window = window.filter(|n| *n > 0).or(context.window);
                    changed = chat.context != before;
                });
                match edited {
                    Ok(chat) if changed => publish(
                        &mut lock(&self.inner.list).watchers,
                        ChatsUpdate::Chat { chat },
                    ),
                    Ok(_) => {}
                    Err(e) => log::warn!("chat {chat_id}: saving context usage: {e}"),
                }
            }
            AgentEvent::AvailableCommands { commands } => {
                st.commands = commands.clone();
                if let Some(session) = &mut st.session {
                    session.commands = commands;
                    session.updated_at = now_ms();
                    let session = session.clone();
                    self.publish_session(chat_id, Some(session));
                }
            }
            AgentEvent::Done { status, .. } => {
                // Nobody is waiting on them any more.
                st.secrets.clear();
                self.sync_secrets(chat_id, st);
                // Status and duration, which the event alone doesn't carry.
                if let Some(message) = finished {
                    publish(&mut st.watchers, MessagesUpdate::Message { message });
                }
                self.publish_chat(chat_id);
                if status == DoneStatus::Completed {
                    self.maybe_title(chat_id);
                }
                let handover = std::mem::take(&mut st.handover);
                // The next turn starts a run with the new config, once
                // background work is done.
                if st.restart && st.background().is_empty() {
                    self.end_run(chat_id, st);
                }
                // A turn the user stopped holds the queue.
                let stopped = status == DoneStatus::Interrupted && !handover;
                if !stopped && self.advance_queue(chat_id, runtime, st) {
                    return;
                }
                if st.run.is_none() {
                    return;
                }
                let status = match status {
                    DoneStatus::Errored => SessionStatus::Errored,
                    DoneStatus::Completed | DoneStatus::Interrupted => SessionStatus::Idle,
                };
                self.set_status(chat_id, st, status);
                self.arm_idle_timer(chat_id, runtime, st);
            }
            _ => {}
        }
    }

    fn settle_queued(
        &self,
        st: &mut ChatState,
        command_id: &str,
        status: CommandStatus,
        resolution: Option<String>,
    ) {
        match self.store().resolve_command(command_id, status, resolution) {
            Ok(command) => publish(&mut st.watchers, MessagesUpdate::Command { command }),
            Err(e) => log::warn!("settling command {command_id}: {e}"),
        }
    }

    /// Replaces the session's background tasks, keeping when each was first
    /// seen. Once the last one ends between turns the run may idle out, or
    /// close for a pending config change.
    fn set_background(
        &self,
        chat_id: &str,
        runtime: &Arc<ChatRuntime>,
        st: &mut ChatState,
        mut tasks: Vec<BackgroundTask>,
    ) {
        let Some(session) = &mut st.session else {
            return;
        };
        let now = now_ms();
        for task in &mut tasks {
            let seen = session.background.iter().find(|t| t.id == task.id);
            task.started_at = seen.and_then(|t| t.started_at).or(Some(now));
        }
        if session.background == tasks {
            return;
        }
        session.background = tasks;
        session.updated_at = now;
        let session = session.clone();
        self.publish_session(chat_id, Some(session));
        if st.busy() {
            return;
        }
        if st.restart {
            self.end_run(chat_id, st);
        } else {
            self.arm_idle_timer(chat_id, runtime, st);
        }
    }

    // Session lifecycle

    /// Closes the run once it has sat idle for the configured timeout.
    fn arm_idle_timer(&self, chat_id: &str, runtime: &Arc<ChatRuntime>, st: &ChatState) {
        let Some(run) = &st.run else {
            return;
        };
        let (run_id, activity) = (run.id, run.activity);
        let engine = self.clone();
        let chat_id = chat_id.to_owned();
        let runtime = runtime.clone();
        self.inner.runtime.spawn(async move {
            tokio::time::sleep(engine.inner.config.idle_timeout).await;
            let mut st = lock(&runtime.state);
            let still_idle = st
                .run
                .as_ref()
                .is_some_and(|r| r.id == run_id && r.activity == activity);
            // A held queue doesn't need the process; its next turn starts one.
            // Background work does.
            if still_idle && !st.busy() {
                engine.end_run(&chat_id, &mut st);
            }
        });
    }

    fn end_run(&self, chat_id: &str, st: &mut ChatState) {
        if let Some(run) = st.run.take() {
            run.handle.close();
        }
        st.restart = false;
        st.commands.clear();
        st.secrets.clear();
        if st.session.take().is_some() {
            self.publish_session(chat_id, None);
        }
    }

    fn set_status(&self, chat_id: &str, st: &mut ChatState, status: SessionStatus) {
        let now = now_ms();
        let session = match &mut st.session {
            Some(session) if session.status == status => return,
            Some(session) => {
                session.status = status;
                session.updated_at = now;
                session
            }
            None => st.session.insert(Session {
                chat_id: chat_id.to_owned(),
                status,
                started_at: Some(now),
                updated_at: now,
                commands: st.commands.clone(),
                background: Vec::new(),
                secrets: Vec::new(),
            }),
        };
        let session = session.clone();
        self.publish_session(chat_id, Some(session));
    }

    // Chat list

    fn publish_chat(&self, chat_id: &str) {
        match self.store().chat(chat_id) {
            Ok(Some(chat)) => publish(
                &mut lock(&self.inner.list).watchers,
                ChatsUpdate::Chat { chat },
            ),
            Ok(None) => {}
            Err(e) => log::warn!("reading chat {chat_id}: {e}"),
        }
    }

    fn publish_session(&self, chat_id: &str, session: Option<Session>) {
        let mut list = lock(&self.inner.list);
        match &session {
            Some(s) => list.sessions.insert(chat_id.to_owned(), s.clone()),
            None => list.sessions.remove(chat_id),
        };
        publish(
            &mut list.watchers,
            ChatsUpdate::Session {
                chat_id: chat_id.to_owned(),
                session,
            },
        );
    }
}

fn take_queued(st: &mut ChatState, command_id: &str) -> Result<Queued> {
    let i = st
        .queued
        .iter()
        .position(|q| q.command_id == command_id)
        .ok_or(EngineError::NotQueued)?;
    Ok(st.queued.remove(i).expect("position is in range"))
}

fn answer(st: &mut ChatState, request_id: String, answers: Vec<UserInputAnswer>) -> Outcome {
    match &mut st.run {
        Some(run) if run.inputs.contains(&request_id) => {
            run.inputs.remove(&request_id);
            run.handle.answer(request_id, answers);
            Outcome::Applied
        }
        _ => Outcome::Rejected("That question is no longer waiting for an answer.".into()),
    }
}

fn interrupt(st: &ChatState) -> Outcome {
    match &st.run {
        Some(run) if st.in_flight() => {
            run.handle.interrupt();
            Outcome::Applied
        }
        _ => Outcome::Rejected("Nothing is running.".into()),
    }
}
