//! outcode-engine — chats and their live runs, over the store.
//!
//! Each chat has at most one live run: started by its first prompt (resuming
//! the CLI's session, so the agent remembers the chat), kept for the prompts
//! after, and closed once it has sat idle for the idle timeout (never while
//! it has background work). Every event is recorded in the store and passed
//! on to watchers: `watch_chats` hears the chat list and each chat's live
//! [`Session`] (running, queued prompts, background tasks, context), and
//! `watch_messages` one chat's transcript, each a snapshot first and then
//! every change.
//!
//! A prompt sent while a turn runs waits in the chat's queue and goes once
//! the turn ends, or stops it ([`SendMode`]). After the user stops a turn the
//! queue is held until a turn they start ends, or one is sent now.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use outcode_git::GitError;
use outcode_harness::{Harness, HarnessError, Run, RunHandle};
use outcode_proto::{
    AgentEvent, Attachment, Chat, ChatConfig, ChatsUpdate, ContextWindow, DoneStatus, InputResponse, MessagesUpdate,
    McpServer, MessagePart, NewWorktree, SecretRequest, WorktreeStep, has_running_spawn, has_spawn,
    QueuedPrompt, RunRequest, Session,
};
use outcode_store::{Store, StoreError, Turn, new_id, now_ms};
use tokio::sync::mpsc;

mod branches;
mod titles;

pub type WatchId = u64;

/// Ended turns kept for their background subagents to report into.
const MAX_ENDED: usize = 8;

#[derive(Debug, thiserror::Error)]
pub enum EngineError {
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error("no chat {0}")]
    NotFound(String),
    #[error("the chat's agent isn't running")]
    NotRunning,
    #[error(transparent)]
    Git(#[from] GitError),
}

pub type Result<T> = std::result::Result<T, EngineError>;

/// What the engine runs things with: the Claude harness and the settings in
/// the app, a mock harness in tests.
pub struct Hooks {
    /// Runs chats' agents, and the text runs.
    pub harness: Arc<dyn Harness>,
    /// The model a text run for this use (a chat's title, a worktree's
    /// branch name) answers with, empty for the harness's default; `None`
    /// while that use is off. Read as each one starts.
    pub text_model: Box<dyn Fn(TextUse) -> Option<String> + Send + Sync>,
    /// How long a run may sit between turns before it's closed; read as each
    /// turn ends, so a settings change applies from the next one.
    pub idle: Box<dyn Fn() -> Duration + Send + Sync>,
    /// Where new worktrees go and how they're named; read as each is made
    /// (and as a worktree chat is deleted).
    pub worktrees: Box<dyn Fn() -> WorktreeOptions + Send + Sync>,
}

/// What a text run is for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TextUse {
    /// A chat's title, from its first prompt.
    Title,
    /// A worktree's semantic branch name, from the chat's first prompt.
    Branch,
}

/// How chats' worktrees are made and cleaned up.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorktreeOptions {
    /// New worktrees go in a subfolder each of this.
    pub dir: PathBuf,
    /// Branches are `<type>/<slug>`, both written by a text run, rather than
    /// `<prefix>/<slug>`.
    pub semantic: bool,
    /// With static naming, the prefix; empty for just the slug.
    pub prefix: String,
    /// Deleting a worktree chat deletes its branch too, merged or not.
    pub delete_branch: bool,
}

impl Default for WorktreeOptions {
    fn default() -> Self {
        Self {
            dir: std::env::temp_dir().join("outcode-worktrees"),
            semantic: false,
            prefix: "outcode".into(),
            delete_branch: false,
        }
    }
}

/// What sending does while the chat's turn runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SendMode {
    /// Queue it; it goes once the turn ends.
    Queue,
    /// Queue it; once the turn's running tool calls finish, the turn is
    /// stopped and it goes next. A turn that ends first just starts it.
    AfterTool,
    /// Stop the turn and send it next.
    Now,
}

type ChatsSink = Box<dyn Fn(ChatsUpdate) -> bool + Send>;
type MessagesSink = Box<dyn Fn(MessagesUpdate) -> bool + Send>;

#[derive(Clone)]
pub struct Engine {
    shared: Arc<Shared>,
}

struct Shared {
    store: Store,
    hooks: Hooks,
    state: Mutex<State>,
    /// Outcode's own MCP server, launched beside each chat's agent.
    mcp: Mutex<Option<McpServer>>,
}

#[derive(Default)]
struct State {
    runs: HashMap<String, Live>,
    /// Chats' live state; a chat without an entry has a blank one.
    sessions: HashMap<String, Session>,
    watchers: Watchers,
    next_run: u64,
    /// Chats whose title is being written.
    titling: HashSet<String>,
}

struct Live {
    /// Tells this run from a later one of the same chat.
    id: u64,
    handle: RunHandle,
    /// The turn in flight; none between turns.
    turn: Option<Turn>,
    /// Turns that ended while their subagents worked on in the background,
    /// oldest first (at most [`MAX_ENDED`]): where those subagents report.
    ended: Vec<Turn>,
    /// The user stopped the turn in flight.
    stopped: bool,
    /// Queued prompts ([`SendMode::AfterTool`]) that stop the turn in flight
    /// once its running tool calls finish.
    after_tool: Vec<String>,
    /// Turns finished, so an idle timer can tell whether another came since.
    finished: u64,
    /// The chat's config changed mid-turn: the run closes once the turn ends,
    /// and the next prompt resumes the session with the new one.
    stale: bool,
}

#[derive(Default)]
struct Watchers {
    next: WatchId,
    chats: Vec<(WatchId, ChatsSink)>,
    messages: Vec<(WatchId, String, MessagesSink)>,
}

impl Watchers {
    fn id(&mut self) -> WatchId {
        self.next += 1;
        self.next
    }

    /// Sends to every chats watcher, dropping the ones whose receiver is gone.
    fn chats(&mut self, update: ChatsUpdate) {
        self.chats.retain(|(_, sink)| sink(update.clone()));
    }

    fn messages(&mut self, chat_id: &str, update: MessagesUpdate) {
        self.messages
            .retain(|(_, chat, sink)| chat != chat_id || sink(update.clone()));
    }
}

impl State {
    fn session(&mut self, chat_id: &str) -> &mut Session {
        self.sessions
            .entry(chat_id.to_owned())
            .or_insert_with(|| Session::new(chat_id))
    }

    /// Changes the chat's session and tells the watchers, if that changed it.
    fn update_session(&mut self, chat_id: &str, update: impl FnOnce(&mut Session)) {
        let session = self.session(chat_id);
        let before = session.clone();
        update(session);
        if *session == before {
            return;
        }
        let session = session.clone();
        if session.is_blank() {
            self.sessions.remove(chat_id);
        }
        self.watchers.chats(ChatsUpdate::Session { session });
    }

    fn working(&self, chat_id: &str) -> bool {
        self.runs.get(chat_id).is_some_and(|live| live.turn.is_some())
    }
}

impl Engine {
    pub fn new(store: Store, hooks: Hooks) -> Self {
        Self {
            shared: Arc::new(Shared {
                store,
                hooks,
                state: Mutex::default(),
                mcp: Mutex::default(),
            }),
        }
    }

    /// Launches `server` (Outcode's MCP server) beside each run started from now on.
    pub fn set_mcp(&self, server: Option<McpServer>) {
        *self.shared.mcp.lock().unwrap_or_else(PoisonError::into_inner) = server;
    }

    fn state(&self) -> MutexGuard<'_, State> {
        self.shared.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub fn store(&self) -> &Store {
        &self.shared.store
    }

    pub fn harness(&self) -> &Arc<dyn Harness> {
        &self.shared.hooks.harness
    }

    /// Starts a text run for `purpose` answering `prompt`; `None` while
    /// that use is off.
    pub(crate) fn run_text(&self, purpose: TextUse, prompt: String) -> Option<std::result::Result<Run, HarnessError>> {
        let model = (self.shared.hooks.text_model)(purpose)?;
        Some(self.harness().run_text(prompt, Some(&model)))
    }

    // Chats

    /// Most recently active first.
    pub fn chats(&self) -> Result<Vec<Chat>> {
        Ok(self.store().chats()?)
    }

    pub fn create_chat(&self, cwd: String, config: ChatConfig) -> Result<Chat> {
        let chat = self.store().create_chat(cwd, config)?;
        self.state()
            .watchers
            .chats(ChatsUpdate::Upsert { chat: chat.clone() });
        Ok(chat)
    }

    /// A chat in a worktree of its own: a new branch off `worktree.base`,
    /// checked out under [`WorktreeOptions::dir`]. The chat keeps `cwd` as
    /// its project; its agent runs in the worktree. `progress` hears each
    /// step as it starts.
    pub async fn create_chat_in_worktree(
        &self,
        cwd: String,
        config: ChatConfig,
        worktree: NewWorktree,
        progress: impl Fn(WorktreeStep) + Send + Sync,
    ) -> Result<Chat> {
        // Short, since the path shows in every tool call.
        let key: String = new_id().chars().filter(char::is_ascii_alphanumeric).take(8).collect();
        let options = (self.shared.hooks.worktrees)();
        let dir = options.dir.join(key);
        let hint = worktree.hint.as_deref().unwrap_or_default();
        let (prefix, hint) = if options.semantic {
            progress(WorktreeStep::Naming);
            self.semantic_branch(hint).await
        } else {
            (options.prefix, hint.to_owned())
        };
        progress(WorktreeStep::CheckingOut {
            branch: outcode_git::prefixed(&prefix, &outcode_git::branch_slug(&hint)),
        });
        let made = outcode_git::add_worktree(Path::new(&cwd), &dir, worktree.base.as_deref(), &prefix, &hint).await?;
        let saved = self.store().create_chat(cwd.clone(), config).and_then(|mut chat| {
            chat.worktree = Some(made.clone());
            self.store().save_chat(&chat)?;
            Ok(chat)
        });
        let chat = match saved {
            Ok(chat) => chat,
            Err(e) => {
                let _ = outcode_git::remove_worktree(Path::new(&cwd), &made).await;
                return Err(e.into());
            }
        };
        self.state()
            .watchers
            .chats(ChatsUpdate::Upsert { chat: chat.clone() });
        Ok(chat)
    }

    /// Changes a chat and tells the watchers, if anything changed.
    fn update(&self, chat_id: &str, update: impl FnOnce(&mut Chat)) -> Result<Chat> {
        let mut state = self.state();
        self.update_locked(&mut state, chat_id, update)
    }

    fn update_locked(&self, state: &mut State, chat_id: &str, update: impl FnOnce(&mut Chat)) -> Result<Chat> {
        let before = self
            .store()
            .chat(chat_id)?
            .ok_or_else(|| EngineError::NotFound(chat_id.into()))?;
        let chat = self.store().update_chat(chat_id, update)?;
        if chat != before {
            state.watchers.chats(ChatsUpdate::Upsert { chat: chat.clone() });
        }
        Ok(chat)
    }

    /// A blank title clears it.
    pub fn rename(&self, chat_id: &str, title: Option<String>) -> Result<Chat> {
        let title = title.map(|t| t.trim().to_owned()).filter(|t| !t.is_empty());
        self.update(chat_id, |chat| chat.title = title)
    }

    /// Archiving unpins.
    pub fn set_archived(&self, chat_id: &str, archived: bool) -> Result<Chat> {
        self.update(chat_id, |chat| {
            chat.archived = archived;
            if archived {
                chat.pinned_at = None;
            }
        })
    }

    pub fn set_pinned(&self, chat_id: &str, pinned: bool) -> Result<Chat> {
        self.update(chat_id, |chat| {
            if pinned != chat.pinned_at.is_some() {
                chat.pinned_at = pinned.then(now_ms);
            }
        })
    }

    /// Sets what the chat runs on. Access and plan mode switch a live run in
    /// place. A CLI takes its model and effort only as it starts, so for
    /// those the live run closes (once a running turn ends) and the next
    /// prompt resumes the session with the new config.
    pub fn set_config(&self, chat_id: &str, config: ChatConfig) -> Result<Chat> {
        let mut state = self.state();
        let before = self
            .store()
            .chat(chat_id)?
            .ok_or_else(|| EngineError::NotFound(chat_id.into()))?
            .config;
        let chat = self.update_locked(&mut state, chat_id, |chat| chat.config = config)?;
        if chat.config == before {
            return Ok(chat);
        }
        let config = &chat.config;
        if config.same_launch(&before) {
            if let Some(live) = state.runs.get(chat_id) {
                live.handle.set_modes(config.access, config.plan);
            }
            return Ok(chat);
        }
        match state.runs.get_mut(chat_id) {
            Some(live) if live.turn.is_some() => live.stale = true,
            Some(_) => {
                if let Some(live) = state.runs.remove(chat_id) {
                    live.handle.close();
                }
            }
            None => {}
        }
        Ok(chat)
    }

    /// Deletes the chat and its transcript, stopping its run. Its worktree
    /// is removed in the background, once the run has let go of it; the
    /// branch is kept unless [`WorktreeOptions::delete_branch`]. Must be
    /// called inside a tokio runtime.
    pub fn delete_chat(&self, chat_id: &str) -> Result<()> {
        let mut state = self.state();
        let chat = self.store().chat(chat_id)?;
        if let Some(live) = state.runs.remove(chat_id) {
            live.handle.interrupt();
            live.handle.close();
        }
        state.sessions.remove(chat_id);
        self.store().delete_chat(chat_id)?;
        state.watchers.chats(ChatsUpdate::Removed { id: chat_id.into() });
        if let Some((cwd, worktree)) = chat.and_then(|c| Some((c.cwd, c.worktree?))) {
            let delete_branch = (self.shared.hooks.worktrees)().delete_branch;
            tokio::spawn(async move {
                let cwd = Path::new(&cwd);
                if let Err(e) = outcode_git::remove_worktree(cwd, &worktree).await {
                    eprintln!("[engine] removing worktree {}: {e}", worktree.root);
                } else if delete_branch
                    && cwd.is_dir()
                    && let Err(e) = outcode_git::delete(cwd, &worktree.branch).await
                {
                    eprintln!("[engine] deleting branch {}: {e}", worktree.branch);
                }
            });
        }
        Ok(())
    }

    // Turns

    /// Sends `prompt` (with `attachments`) to the chat's live run, starting
    /// one when there's none. While a turn runs it waits in the queue
    /// instead. The prompt and the reply's start are recorded at once; the
    /// reply streams to watchers from there. A run that can't start ends the
    /// reply with the error. Must be called inside a tokio runtime.
    pub fn send(&self, chat_id: &str, prompt: String, attachments: Vec<Attachment>) -> Result<()> {
        self.send_with(chat_id, prompt, attachments, SendMode::Queue)
    }

    /// [`Engine::send`], with `mode` saying what happens to a running turn.
    pub fn send_with(&self, chat_id: &str, prompt: String, attachments: Vec<Attachment>, mode: SendMode) -> Result<()> {
        if self.store().chat(chat_id)?.is_none() {
            return Err(EngineError::NotFound(chat_id.into()));
        }
        let mut state = self.state();
        if state.working(chat_id) {
            let queued = QueuedPrompt {
                id: new_id(),
                prompt,
                attachments,
            };
            let id = queued.id.clone();
            state.update_session(chat_id, |s| s.queued.push(queued));
            match mode {
                SendMode::Queue => {}
                SendMode::AfterTool => {
                    if let Some(live) = state.runs.get_mut(chat_id) {
                        live.after_tool.push(id);
                    }
                }
                SendMode::Now => self.send_now(&mut state, chat_id, &id)?,
            }
            return Ok(());
        }
        // A prompt the user sends themselves lifts a hold once its turn ends.
        self.start(&mut state, chat_id, Some(prompt), attachments)
    }

    /// Starts a turn: `prompt`'s, or one the agent began on its own.
    fn start(&self, state: &mut State, chat_id: &str, prompt: Option<String>, attachments: Vec<Attachment>) -> Result<()> {
        let paths: Vec<String> = attachments.iter().map(|a| a.path.clone()).collect();
        let (mut turn, chat) = self.store().start_turn(chat_id, prompt.as_deref(), attachments)?;
        let State {
            runs,
            watchers,
            next_run,
            titling,
            ..
        } = &mut *state;
        for message in turn.user.iter().chain([&turn.assistant]) {
            let message = message.clone();
            watchers.messages(chat_id, MessagesUpdate::Upsert { message });
        }
        watchers.chats(ChatsUpdate::Upsert { chat: chat.clone() });
        if chat.title.is_none()
            && let Some(prompt) = &prompt
        {
            self.maybe_title(titling, chat_id, prompt);
        }

        let Some(prompt) = prompt else {
            // The agent's own turn: its run is live.
            if let Some(live) = runs.get_mut(chat_id) {
                live.turn = Some(turn);
                live.stopped = false;
            }
            state.update_session(chat_id, |s| s.working = true);
            return Ok(());
        };

        if let Some(live) = runs.get_mut(chat_id)
            && live.handle.send(prompt.clone(), paths.clone())
        {

            live.turn = Some(turn);
            live.stopped = false;
            state.update_session(chat_id, |s| s.working = true);
            return Ok(());
        }

        // Its folder may have been deleted since; bring it back first.
        if let Some(worktree) = &chat.worktree
            && let Err(error) = outcode_git::restore_worktree(Path::new(&chat.cwd), worktree)
        {
            for event in [
                AgentEvent::Error {
                    message: format!("The chat's worktree is missing and couldn't be restored: {error}"),
                },
                AgentEvent::Done {
                    status: DoneStatus::Errored,
                },
            ] {
                self.record(watchers, &mut turn, event);
            }
            return Ok(());
        }
        let request = RunRequest {
            cwd: chat.work_dir().to_owned(),
            prompt,
            attachments: paths,
            resume: chat.session_id,
            config: chat.config,
            auto_compact_window: None,
            mcp: self.shared.mcp.lock().unwrap_or_else(PoisonError::into_inner).as_ref().map(|m| m.for_chat(chat_id)),
        };
        match self.shared.hooks.harness.run(request) {
            Ok(run) => {
                *next_run += 1;
                let id = *next_run;
                runs.insert(
                    chat_id.into(),
                    Live {
                        id,
                        handle: run.handle,
                        turn: Some(turn),
                        ended: Vec::new(),
                        stopped: false,
                        after_tool: Vec::new(),
                        finished: 0,
                        stale: false,
                    },
                );
                tokio::spawn(self.clone().pump(chat_id.into(), id, run.events));
                state.update_session(chat_id, |s| s.working = true);
            }
            Err(error) => {
                for event in [
                    AgentEvent::Error {
                        message: error.to_string(),
                    },
                    AgentEvent::Done {
                        status: DoneStatus::Errored,
                    },
                ] {
                    self.record(watchers, &mut turn, event);
                }
            }
        }
        Ok(())
    }

    /// Stops the chat's running turn; its run stays up for the next prompt.
    /// The queue waits until a turn the user starts ends.
    pub fn interrupt(&self, chat_id: &str) {
        let mut state = self.state();
        let Some(live) = state.runs.get_mut(chat_id).filter(|live| live.turn.is_some()) else {
            return;
        };
        live.handle.interrupt();
        live.stopped = true;
        state.update_session(chat_id, |s| s.held = !s.queued.is_empty());
    }

    /// Answers what the chat's turn asked. Approving a plan leaves plan mode.
    pub fn answer(&self, chat_id: &str, request_id: &str, response: InputResponse) -> Result<()> {
        let mut state = self.state();
        let live = state.runs.get(chat_id).ok_or(EngineError::NotRunning)?;
        if !live.handle.answer(request_id, response.clone()) {
            return Err(EngineError::NotRunning);
        }
        if let InputResponse::Plan { approve: true, .. } = response {
            self.update_locked(&mut state, chat_id, |chat| chat.config.plan = false)?;
        }
        Ok(())
    }

    /// Stops one of the chat's background tasks.
    pub fn stop_task(&self, chat_id: &str, task_id: &str) -> Result<()> {
        let state = self.state();
        let live = state.runs.get(chat_id).ok_or(EngineError::NotRunning)?;
        live.handle.stop_task(task_id);
        Ok(())
    }

    // Secrets

    /// Shows the chat's user a card asking for a secret.
    pub fn open_secret_request(&self, chat_id: &str, request: SecretRequest) {
        self.state().update_session(chat_id, |s| s.secrets.push(request));
    }

    /// Takes the card down, answered or not.
    pub fn close_secret_request(&self, chat_id: &str, id: &str) {
        self.state().update_session(chat_id, |s| s.secrets.retain(|r| r.id != id));
    }

    // The queue

    /// Drops a queued prompt.
    pub fn cancel_queued(&self, chat_id: &str, id: &str) {
        let mut state = self.state();
        state.update_session(chat_id, |s| {
            s.queued.retain(|q| q.id != id);
            s.held &= !s.queued.is_empty();
        });
    }

    /// Puts the queue in `order` (queued ids); ids it leaves out keep their
    /// place after those it names.
    pub fn reorder_queued(&self, chat_id: &str, order: &[String]) {
        let mut state = self.state();
        state.update_session(chat_id, |s| {
            let rank = |q: &QueuedPrompt| order.iter().position(|id| *id == q.id).unwrap_or(usize::MAX);
            s.queued.sort_by_key(rank);
        });
    }

    /// Sends a queued prompt now: the running turn is stopped and it goes
    /// next, ahead of the rest, which then follow without a hold.
    pub fn send_queued_now(&self, chat_id: &str, id: &str) -> Result<()> {
        self.send_now(&mut self.state(), chat_id, id)
    }

    fn send_now(&self, state: &mut State, chat_id: &str, id: &str) -> Result<()> {
        let Some(at) = state.sessions.get(chat_id).and_then(|s| s.queued.iter().position(|q| q.id == id)) else {
            return Ok(());
        };
        state.update_session(chat_id, |s| {
            let item = s.queued.remove(at);
            s.queued.insert(0, item);
            s.held = false;
        });
        match state.runs.get_mut(chat_id).filter(|live| live.turn.is_some()) {
            // Its end starts the queue.
            Some(live) => {
                live.handle.interrupt();
                live.stopped = false;
                live.after_tool.clear();
                Ok(())
            }
            None => self.next_queued(state, chat_id),
        }
    }

    /// Starts the queue's first prompt, unless it's held or a turn runs.
    fn next_queued(&self, state: &mut State, chat_id: &str) -> Result<()> {
        if state.working(chat_id) {
            return Ok(());
        }
        let Some(session) = state.sessions.get(chat_id).filter(|s| !s.held && !s.queued.is_empty()) else {
            return Ok(());
        };
        let next = session.queued[0].clone();
        state.update_session(chat_id, |s| {
            s.queued.remove(0);
        });
        self.start(state, chat_id, Some(next.prompt), next.attachments)
    }

    /// Records `event` into `turn` and passes it on. True when it ended the turn.
    fn record(&self, watchers: &mut Watchers, turn: &mut Turn, event: AgentEvent) -> bool {
        let chat_id = turn.chat_id.clone();
        match self.store().record(turn, &event) {
            Ok(Some(chat)) => watchers.chats(ChatsUpdate::Upsert { chat }),
            Ok(None) => {}
            // The UI still shows it; only the saved copy misses it.
            Err(error) => eprintln!("[engine] recording {chat_id}: {error}"),
        }
        let done = matches!(event, AgentEvent::Done { .. });
        let message_id = turn.assistant.id.clone();
        watchers.messages(&chat_id, MessagesUpdate::Event { message_id, event });
        if done {
            let message = turn.assistant.clone();
            watchers.messages(&chat_id, MessagesUpdate::Upsert { message });
        }
        done
    }

    /// Feeds run `id`'s events into its chat's turns until the process exits.
    async fn pump(self, chat_id: String, id: u64, mut events: mpsc::Receiver<AgentEvent>) {
        while let Some(event) = events.recv().await {
            self.on_event(&chat_id, id, event);
        }
        let mut state = self.state();
        if state.runs.get(&chat_id).is_none_or(|live| live.id != id) {
            return;
        }
        let live = state.runs.remove(&chat_id).expect("checked above");
        // The driver ends a turn the process died in; this is a fallback.
        if let Some(mut turn) = live.turn {
            for event in [
                AgentEvent::Error {
                    message: "The agent exited unexpectedly.".into(),
                },
                AgentEvent::Done {
                    status: DoneStatus::Errored,
                },
            ] {
                self.record(&mut state.watchers, &mut turn, event);
            }
        }
        for mut last in live.ended {
            let _ = self.store().flush(&mut last);
        }
        state.update_session(&chat_id, |s| {
            s.working = false;
            s.tasks.clear();
        });
        if let Err(error) = self.next_queued(&mut state, &chat_id) {
            eprintln!("[engine] queue of {chat_id}: {error}");
        }
    }

    fn on_event(&self, chat_id: &str, id: u64, event: AgentEvent) {
        let mut state = self.state();
        if state.runs.get(chat_id).is_none_or(|live| live.id != id) {
            return;
        }
        // Session state: kept beside the transcript, never recorded.
        match event {
            AgentEvent::BackgroundTasks { tasks } => {
                return state.update_session(chat_id, |s| s.tasks = tasks);
            }
            AgentEvent::AvailableCommands { commands } => {
                return state.update_session(chat_id, |s| s.commands = commands);
            }
            AgentEvent::ContextUsage { tokens, window } => {
                return state.update_session(chat_id, |s| {
                    let context = s.context.get_or_insert_with(ContextWindow::default);
                    context.tokens = tokens.or(context.tokens);
                    context.window = window.or(context.window);
                });
            }
            AgentEvent::Usage { .. } => return,
            _ => {}
        }
        let State { runs, watchers, .. } = &mut *state;
        let live = runs.get_mut(chat_id).expect("checked above");
        // A subagent's traffic goes to the reply that spawned it: the one in
        // flight, or one that ended while it worked on in the background.
        if let AgentEvent::Subagent { parent_tool_id, .. } = &event
            && !live.turn.as_ref().is_some_and(|t| has_spawn(&t.assistant.parts, parent_tool_id))
        {
            if let Some(at) = live.ended.iter().position(|t| has_spawn(&t.assistant.parts, parent_tool_id)) {
                let turn = &mut live.ended[at];
                self.record(watchers, turn, event);
                if !has_running_spawn(&turn.assistant.parts) {
                    let mut turn = live.ended.remove(at);
                    let _ = self.store().flush(&mut turn);
                }
            }
            return;
        }
        if live.turn.is_none() {
            // The agent started a turn of its own; anything else between
            // turns has nothing to fold into.
            if !matches!(event, AgentEvent::BackgroundTurn { .. }) {
                return;
            }
            if let Err(error) = self.start(&mut state, chat_id, None, Vec::new()) {
                eprintln!("[engine] background turn of {chat_id}: {error}");
                return;
            }
        }
        let State { runs, watchers, .. } = &mut *state;
        let live = runs.get_mut(chat_id).expect("checked above");
        let Some(turn) = live.turn.as_mut() else {
            return;
        };
        let tool_done = matches!(event, AgentEvent::ToolResult { .. });
        if !self.record(watchers, turn, event) {
            if tool_done {
                self.after_tool(&mut state, chat_id);
            }
            return;
        }
        let ended = live.turn.take().expect("recorded into it");
        live.after_tool.clear();
        // Its subagents still working in the background report into it.
        if has_running_spawn(&ended.assistant.parts) {
            live.ended.push(ended);
            if live.ended.len() > MAX_ENDED {
                let mut oldest = live.ended.remove(0);
                let _ = self.store().flush(&mut oldest);
            }
        }
        let stopped = std::mem::take(&mut live.stopped);
        let stale = live.stale;
        live.finished += 1;
        let finished = live.finished;
        if stale && let Some(live) = runs.remove(chat_id) {
            live.handle.close();
        }
        state.update_session(chat_id, |s| {
            s.working = false;
            // A hold lasts until a turn the user starts ends.
            s.held &= stopped;
        });
        if let Err(error) = self.next_queued(&mut state, chat_id) {
            eprintln!("[engine] queue of {chat_id}: {error}");
        }
        if !stale {
            self.close_when_idle(chat_id.to_owned(), id, finished);
        }
    }

    /// A tool call of the turn in flight finished: once none still runs, the
    /// first prompt sent to go after one stops the turn and goes next.
    fn after_tool(&self, state: &mut State, chat_id: &str) {
        let Some(live) = state.runs.get(chat_id).filter(|live| !live.after_tool.is_empty() && !live.stopped) else {
            return;
        };
        let running = live.turn.as_ref().is_some_and(|turn| {
            turn.assistant
                .parts
                .iter()
                .any(|p| matches!(p, MessagePart::Tool { resolved: false, .. }))
        });
        if running {
            return;
        }
        let next = state
            .sessions
            .get(chat_id)
            .and_then(|s| s.queued.iter().find(|q| live.after_tool.contains(&q.id)))
            .map(|q| q.id.clone());
        let result = match next {
            Some(id) => self.send_now(state, chat_id, &id),
            // Cancelled since.
            None => {
                if let Some(live) = state.runs.get_mut(chat_id) {
                    live.after_tool.clear();
                }
                Ok(())
            }
        };
        if let Err(error) = result {
            eprintln!("[engine] queue of {chat_id}: {error}");
        }
    }

    /// Closes run `id` once it has sat idle for the idle timeout after its
    /// `finished`th turn, unless another turn came since. Background work
    /// keeps it up.
    fn close_when_idle(&self, chat_id: String, id: u64, finished: u64) {
        let engine = self.clone();
        tokio::spawn(async move {
            loop {
                let idle = (engine.shared.hooks.idle)();
                tokio::time::sleep(idle).await;
                let mut state = engine.state();
                let current = state
                    .runs
                    .get(&chat_id)
                    .is_some_and(|live| live.id == id && live.turn.is_none() && live.finished == finished);
                if !current {
                    return;
                }
                if state.sessions.get(&chat_id).is_some_and(|s| !s.tasks.is_empty()) {
                    continue;
                }
                if let Some(mut live) = state.runs.remove(&chat_id) {
                    for last in &mut live.ended {
                        let _ = engine.store().flush(last);
                    }
                    live.handle.close();
                }
                return;
            }
        });
    }

    // Watching

    /// The chat list and live sessions, then every change to them.
    pub fn watch_chats(&self, sink: impl Fn(ChatsUpdate) -> bool + Send + 'static) -> Result<WatchId> {
        let mut state = self.state();
        let chats = self.store().chats()?;
        let sessions = state.sessions.values().cloned().collect();
        let id = state.watchers.id();
        if sink(ChatsUpdate::Snapshot { chats, sessions }) {
            state.watchers.chats.push((id, Box::new(sink)));
        }
        Ok(id)
    }

    /// A chat's messages, a reply being written as far as it got, then
    /// every change to them.
    pub fn watch_messages(
        &self,
        chat_id: &str,
        sink: impl Fn(MessagesUpdate) -> bool + Send + 'static,
    ) -> Result<WatchId> {
        let mut state = self.state();
        let mut messages = self.store().messages(chat_id)?;
        // The saved replies may lag the live ones by up to a second of deltas.
        if let Some(live) = state.runs.get(chat_id) {
            for turn in live.turn.iter().chain(live.ended.iter()) {
                if let Some(saved) = messages.iter_mut().find(|m| m.id == turn.assistant.id) {
                    *saved = turn.assistant.clone();
                }
            }
        }
        let id = state.watchers.id();
        if sink(MessagesUpdate::Snapshot { messages }) {
            state
                .watchers
                .messages
                .push((id, chat_id.to_owned(), Box::new(sink)));
        }
        Ok(id)
    }

    pub fn unwatch(&self, id: WatchId) {
        let mut state = self.state();
        state.watchers.chats.retain(|(w, _)| *w != id);
        state.watchers.messages.retain(|(w, _, _)| *w != id);
    }

    // Shutdown

    /// Whether any run is live.
    pub fn any_live(&self) -> bool {
        !self.state().runs.is_empty()
    }

    /// Closes every run: each one's stdin closes once no login refresh is in
    /// flight. A turn cut short is closed at the next start (`Store::recover`).
    pub fn close_all(&self) {
        let mut state = self.state();
        for (_, mut live) in state.runs.drain() {
            for turn in live.turn.iter_mut().chain(live.ended.iter_mut()) {
                let _ = self.shared.store.flush(turn);
            }
            live.handle.close();
        }
    }
}

#[cfg(test)]
mod tests;
