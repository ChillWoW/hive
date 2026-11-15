//! outcode-engine — chats and their live runs, over the store.
//!
//! Each chat has at most one live run: started by its first prompt (resuming
//! the CLI's session, so the agent remembers the chat), kept for the prompts
//! after, and closed once it has sat idle for the idle timeout. Every event
//! is recorded in the store and passed on to watchers: `watch_chats` hears
//! the chat list, `watch_messages` one chat's transcript, each a snapshot
//! first and then every change.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use outcode_harness::{HarnessError, Run, RunHandle};
use outcode_proto::{AgentEvent, Chat, ChatsUpdate, DoneStatus, MessagesUpdate, RunRequest};
use outcode_store::{Store, StoreError, Turn, now_ms};
use tokio::sync::mpsc;

pub type WatchId = u64;

#[derive(Debug, thiserror::Error)]
pub enum EngineError {
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error("no chat {0}")]
    NotFound(String),
    #[error("the chat is still working on the last prompt")]
    Busy,
}

pub type Result<T> = std::result::Result<T, EngineError>;

/// Starts a run for a request: the Claude driver in the app, a script in tests.
pub type Spawner = dyn Fn(RunRequest) -> std::result::Result<Run, HarnessError> + Send + Sync;

type ChatsSink = Box<dyn Fn(ChatsUpdate) -> bool + Send>;
type MessagesSink = Box<dyn Fn(MessagesUpdate) -> bool + Send>;

#[derive(Clone)]
pub struct Engine {
    shared: Arc<Shared>,
}

struct Shared {
    store: Store,
    spawn: Box<Spawner>,
    /// How long a run may sit between turns before it's closed; read as each
    /// turn ends, so a settings change applies from the next one.
    idle: Box<dyn Fn() -> Duration + Send + Sync>,
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    runs: HashMap<String, Live>,
    watchers: Watchers,
    next_run: u64,
}

struct Live {
    /// Tells this run from a later one of the same chat.
    id: u64,
    handle: RunHandle,
    /// The turn in flight; none between turns.
    turn: Option<Turn>,
    /// Turns finished, so an idle timer can tell whether another came since.
    finished: u64,
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

impl Engine {
    pub fn new(
        store: Store,
        spawn: impl Fn(RunRequest) -> std::result::Result<Run, HarnessError> + Send + Sync + 'static,
        idle: impl Fn() -> Duration + Send + Sync + 'static,
    ) -> Self {
        Self {
            shared: Arc::new(Shared {
                store,
                spawn: Box::new(spawn),
                idle: Box::new(idle),
                state: Mutex::default(),
            }),
        }
    }

    fn state(&self) -> MutexGuard<'_, State> {
        self.shared.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn store(&self) -> &Store {
        &self.shared.store
    }

    // Chats

    /// Most recently active first.
    pub fn chats(&self) -> Result<Vec<Chat>> {
        Ok(self.store().chats()?)
    }

    pub fn create_chat(&self, cwd: String) -> Result<Chat> {
        let chat = self.store().create_chat(cwd)?;
        self.state()
            .watchers
            .chats(ChatsUpdate::Upsert { chat: chat.clone() });
        Ok(chat)
    }

    /// Changes a chat and tells the watchers, if anything changed.
    fn update(&self, chat_id: &str, update: impl FnOnce(&mut Chat)) -> Result<Chat> {
        let mut state = self.state();
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

    /// Deletes the chat and its transcript, stopping its run.
    pub fn delete_chat(&self, chat_id: &str) -> Result<()> {
        let mut state = self.state();
        if let Some(live) = state.runs.remove(chat_id) {
            live.handle.interrupt();
            live.handle.close();
        }
        self.store().delete_chat(chat_id)?;
        state.watchers.chats(ChatsUpdate::Removed { id: chat_id.into() });
        Ok(())
    }

    // Turns

    /// Sends `prompt` to the chat's live run, starting one when there's
    /// none. The prompt and the reply's start are recorded at once; the
    /// reply streams to watchers from there. A run that can't start ends
    /// the reply with the error. Must be called inside a tokio runtime.
    pub fn send(&self, chat_id: &str, prompt: String) -> Result<()> {
        let mut state = self.state();
        let State {
            runs,
            watchers,
            next_run,
        } = &mut *state;
        if runs.get(chat_id).is_some_and(|live| live.turn.is_some()) {
            return Err(EngineError::Busy);
        }
        if self.store().chat(chat_id)?.is_none() {
            return Err(EngineError::NotFound(chat_id.into()));
        }
        let (mut turn, chat) = self.store().start_turn(chat_id, &prompt)?;
        for message in [&turn.user, &turn.assistant] {
            let message = message.clone();
            watchers.messages(chat_id, MessagesUpdate::Upsert { message });
        }
        watchers.chats(ChatsUpdate::Upsert { chat: chat.clone() });
        watchers.chats(ChatsUpdate::Working {
            chat_id: chat_id.into(),
            working: true,
        });

        if let Some(live) = runs.get_mut(chat_id)
            && live.handle.send(prompt.clone())
        {
            live.turn = Some(turn);
            return Ok(());
        }

        let request = RunRequest {
            cwd: chat.cwd,
            prompt,
            resume: chat.session_id,
        };
        match (self.shared.spawn)(request) {
            Ok(run) => {
                *next_run += 1;
                let id = *next_run;
                runs.insert(
                    chat_id.into(),
                    Live {
                        id,
                        handle: run.handle,
                        turn: Some(turn),
                        finished: 0,
                    },
                );
                tokio::spawn(self.clone().pump(chat_id.into(), id, run.events));
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
    pub fn interrupt(&self, chat_id: &str) {
        if let Some(live) = self.state().runs.get(chat_id)
            && live.turn.is_some()
        {
            live.handle.interrupt();
        }
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
            watchers.chats(ChatsUpdate::Working {
                chat_id,
                working: false,
            });
        }
        done
    }

    /// Feeds run `id`'s events into its chat's turns until the process exits.
    async fn pump(self, chat_id: String, id: u64, mut events: mpsc::Receiver<AgentEvent>) {
        while let Some(event) = events.recv().await {
            self.on_event(&chat_id, id, event);
        }
        let mut state = self.state();
        let State { runs, watchers, .. } = &mut *state;
        if runs.get(&chat_id).is_none_or(|live| live.id != id) {
            return;
        }
        let live = runs.remove(&chat_id).expect("checked above");
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
                self.record(watchers, &mut turn, event);
            }
        }
    }

    fn on_event(&self, chat_id: &str, id: u64, event: AgentEvent) {
        let mut state = self.state();
        let State { runs, watchers, .. } = &mut *state;
        let Some(live) = runs.get_mut(chat_id).filter(|live| live.id == id) else {
            return;
        };
        // Between turns there's nothing to fold into.
        let Some(turn) = live.turn.as_mut() else {
            return;
        };
        if self.record(watchers, turn, event) {
            live.turn = None;
            live.finished += 1;
            let finished = live.finished;
            let idle = (self.shared.idle)();
            let engine = self.clone();
            let chat_id = chat_id.to_owned();
            tokio::spawn(async move {
                tokio::time::sleep(idle).await;
                engine.close_if_idle(&chat_id, id, finished);
            });
        }
    }

    /// Closes run `id` if no turn has started since its `finished`th ended.
    fn close_if_idle(&self, chat_id: &str, id: u64, finished: u64) {
        let mut state = self.state();
        let idle = state.runs.get(chat_id).is_some_and(|live| {
            live.id == id && live.turn.is_none() && live.finished == finished
        });
        if idle && let Some(live) = state.runs.remove(chat_id) {
            live.handle.close();
        }
    }

    // Watching

    /// The chat list, then every change to it.
    pub fn watch_chats(&self, sink: impl Fn(ChatsUpdate) -> bool + Send + 'static) -> Result<WatchId> {
        let mut state = self.state();
        let chats = self.store().chats()?;
        let working = state
            .runs
            .iter()
            .filter(|(_, live)| live.turn.is_some())
            .map(|(id, _)| id.clone())
            .collect();
        let id = state.watchers.id();
        if sink(ChatsUpdate::Snapshot { chats, working }) {
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
        // The saved reply may lag the live one by up to a second of deltas.
        if let Some(turn) = state.runs.get(chat_id).and_then(|live| live.turn.as_ref())
            && let Some(saved) = messages.iter_mut().find(|m| m.id == turn.assistant.id)
        {
            *saved = turn.assistant.clone();
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
        for (_, live) in self.state().runs.drain() {
            live.handle.close();
        }
    }
}

#[cfg(test)]
mod tests;
