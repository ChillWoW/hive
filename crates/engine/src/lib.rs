//! hive-engine — runs chats.
//!
//! - Each chat has at most one live [`Run`]. The first prompt starts it
//!   (resuming the harness's own session when the chat has one); later
//!   prompts go to the same process, so a prompt sent mid-turn steers the
//!   next turn. A run left idle for [`EngineConfig::idle_timeout`] is closed
//!   and the next prompt starts a fresh one.
//! - The UI acts through commands ([`Engine::queue_command`]): each is
//!   issued in the store's ledger, executed against the chat's run, and
//!   settled there. A prompt queued behind a running turn stays pending
//!   until its own turn starts.
//! - Every event is recorded through the store's turn (journal, fold,
//!   save) and sent to the chat's watchers, under one per-chat lock, so a
//!   watcher's snapshot and the updates after it never overlap or leave a
//!   gap.
//!
//! [`Run`]: hive_harness::Run

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use hive_harness::{Harness, RunHandle};
use hive_proto::{
    AgentEvent, Chat, ChatConfig, ChatsUpdate, Command, CommandPayload, CommandStatus,
    ContextUsage, DoneStatus, HarnessId, MessageStatus, MessagesUpdate, RunRequest, Session,
    SessionStatus, UserInputAnswer,
};
use hive_store::{new_id, now_ms, Recovery, Store, StoreError, Turn};
use tokio::sync::mpsc;

pub use hive_store;

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
}

impl Default for EngineConfig {
    fn default() -> Self {
        Self {
            idle_timeout: Duration::from_secs(10 * 60),
            resume_interrupted: false,
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum EngineError {
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error("chat {0} not found")]
    ChatNotFound(String),
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
    config: EngineConfig,
    runtime: tokio::runtime::Handle,
    chats: Mutex<HashMap<String, Arc<ChatRuntime>>>,
    /// Lock order: a chat's state, then this; never the other way.
    list: Mutex<ChatList>,
    next_id: AtomicU64,
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
    /// Prompts handed to the run while a turn was in flight, oldest first.
    queued: VecDeque<Queued>,
    session: Option<Session>,
    watchers: Vec<Watcher<MessagesUpdate>>,
}

impl ChatState {
    fn in_flight(&self) -> bool {
        self.turn
            .as_ref()
            .is_some_and(|t| t.assistant.status == Some(MessageStatus::Streaming))
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

struct Queued {
    command_id: String,
    prompt: String,
    message_id: String,
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
                harnesses: harnesses.into_iter().map(|h| (h.id(), h)).collect(),
                config,
                runtime,
                chats: Mutex::default(),
                list: Mutex::default(),
                next_id: AtomicU64::new(1),
            }),
        }
    }

    pub fn store(&self) -> &Store {
        &self.inner.store
    }

    /// Run once at boot, before anything else: recovers what the last
    /// session left unfinished and, if configured, resumes it.
    pub fn start(&self) -> Result<Recovery> {
        let store = self.store();
        let recovery = store.recover()?;
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
            };
            if let Err(e) = self.queue_command(&chat_id, payload) {
                log::warn!("resuming chat {chat_id}: {e}");
            }
        }
        Ok(recovery)
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

    /// Most recently active first.
    pub fn chats(&self) -> Result<Vec<Chat>> {
        Ok(self.store().chats()?)
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
        let pending = self
            .store()
            .commands(chat_id)?
            .into_iter()
            .filter(|c| c.status == CommandStatus::Pending)
            .collect();
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
            CommandPayload::Send { prompt, message_id } => {
                self.send(&chat, &runtime, &mut st, &command.id, prompt, message_id)
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
        prompt: String,
        message_id: String,
    ) -> Result<Outcome> {
        let Some(run) = &st.run else {
            return self.start_run(chat, runtime, st, prompt, message_id);
        };
        if st.in_flight() || !st.queued.is_empty() {
            run.handle.send(prompt.clone());
            st.queued.push_back(Queued {
                command_id: command_id.to_owned(),
                prompt,
                message_id,
            });
            return Ok(Outcome::Queued);
        }
        self.start_turn(&chat.id, st, &prompt, message_id)?;
        if let Some(run) = &st.run {
            run.handle.send(prompt);
        }
        self.set_status(&chat.id, st, SessionStatus::Working);
        Ok(Outcome::Applied)
    }

    fn start_run(
        &self,
        chat: &Chat,
        runtime: &Arc<ChatRuntime>,
        st: &mut ChatState,
        prompt: String,
        message_id: String,
    ) -> Result<Outcome> {
        let Some(harness) = self.inner.harnesses.get(&chat.config.harness) else {
            return Ok(Outcome::Rejected(format!(
                "Hive can't run {:?} chats yet.",
                chat.config.harness
            )));
        };
        let config = &chat.config;
        let request = RunRequest {
            harness: config.harness,
            prompt: prompt.clone(),
            cwd: chat.cwd.clone(),
            sandbox: config.sandbox,
            model: config.model.clone(),
            reasoning: config.reasoning,
            model_options: config.model_options.clone(),
            auto_approve: false,
            resume: chat.harness_session_id.clone(),
            attachments: Vec::new(),
        };
        let run = {
            let _runtime = self.inner.runtime.enter();
            match harness.run(request) {
                Ok(run) => run,
                Err(e) => return Ok(Outcome::Rejected(e.to_string())),
            }
        };
        if let Err(e) = self.start_turn(&chat.id, st, &prompt, message_id) {
            run.handle.close();
            return Err(e);
        }
        let id = self.next_id();
        st.run = Some(LiveRun {
            id,
            handle: run.handle,
            inputs: HashSet::new(),
            activity: 0,
        });
        self.inner.runtime.spawn(self.clone().pump(
            chat.id.clone(),
            runtime.clone(),
            id,
            run.events,
        ));
        self.set_status(&chat.id, st, SessionStatus::Working);
        Ok(Outcome::Applied)
    }

    /// Saves the prompt and an empty reply, and makes it the live turn.
    fn start_turn(
        &self,
        chat_id: &str,
        st: &mut ChatState,
        prompt: &str,
        message_id: String,
    ) -> Result<()> {
        let store = self.store();
        if let Some(previous) = &mut st.turn {
            store.flush(previous)?;
        }
        let turn = store.start_turn(chat_id, prompt, Some(message_id))?;
        for message in [&turn.user, &turn.assistant] {
            publish(
                &mut st.watchers,
                MessagesUpdate::Message {
                    message: message.clone(),
                },
            );
        }
        st.turn = Some(turn);
        self.publish_chat(chat_id);
        Ok(())
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
        if st.in_flight() {
            let done = AgentEvent::Done {
                status: DoneStatus::Errored,
                error: Some("The agent exited before the turn finished.".into()),
                session_id: None,
            };
            self.handle_event(&chat_id, &runtime, &mut st, done);
        }
        let queued: Vec<_> = st.queued.drain(..).collect();
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

        // A queued prompt's turn starts with the first event after the
        // previous `Done`; a late subagent event still belongs to the turn
        // that spawned it.
        if !st.in_flight() && !matches!(event, AgentEvent::Subagent { .. }) {
            if let Some(q) = st.queued.pop_front() {
                match self.start_turn(chat_id, st, &q.prompt, q.message_id) {
                    Ok(()) => self.settle_queued(st, &q.command_id, CommandStatus::Applied, None),
                    Err(e) => log::warn!("chat {chat_id}: starting a queued turn: {e}"),
                }
            }
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
                if st.run.as_ref().is_some_and(|r| r.inputs.is_empty()) =>
            {
                self.set_status(chat_id, st, SessionStatus::Working)
            }
            AgentEvent::ContextUsage { tokens, window } => {
                if let Some(session) = &mut st.session {
                    let context = session.context.get_or_insert_with(ContextUsage::default);
                    context.tokens = tokens.or(context.tokens);
                    context.window = window.or(context.window);
                    session.updated_at = now_ms();
                    let session = session.clone();
                    self.publish_session(chat_id, Some(session));
                }
            }
            AgentEvent::Done { status, .. } => {
                // Status and duration, which the event alone doesn't carry.
                if let Some(message) = finished {
                    publish(&mut st.watchers, MessagesUpdate::Message { message });
                }
                self.publish_chat(chat_id);
                if !st.queued.is_empty() {
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
            if still_idle && !st.in_flight() && st.queued.is_empty() {
                engine.end_run(&chat_id, &mut st);
            }
        });
    }

    fn end_run(&self, chat_id: &str, st: &mut ChatState) {
        if let Some(run) = st.run.take() {
            run.handle.close();
        }
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
                context: None,
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
