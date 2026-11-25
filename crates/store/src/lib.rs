//! outcode-store — Outcode's durable state, under one data directory:
//!
//! - `outcode.db` (SQLite): chats and messages. Each row keeps the proto type
//!   as JSON, plus the columns queries need.
//! - `journals/{chatId}.jsonl`: every event of every run, as it arrived
//!   (see [`journal`]).
//!
//! A turn is recorded through [`Store::start_turn`] and [`Store::record`]:
//! each event is journaled, folded into the assistant message, and the
//! message saved (at most once a second while text streams). After a crash,
//! [`Store::recover`] rebuilds unfinished messages from their journals.

pub mod journal;

use std::path::Path;
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use outcode_proto::{
    AgentEvent, Chat, ChatConfig, DoneStatus, Message, MessagePart, MessageRole, MessageStatus, fold_event,
};
use rusqlite::{Connection, OptionalExtension, params};

pub use journal::{Journal, JournalLine};

/// How often a streaming message is saved while only deltas arrive. The
/// journal has every delta regardless.
const SAVE_INTERVAL: Duration = Duration::from_secs(1);

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("sqlite: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
    #[error("{0} not found")]
    NotFound(String),
}

pub type Result<T> = std::result::Result<T, StoreError>;

/// Schema migrations, applied in order; `PRAGMA user_version` counts how
/// many have run. Append only.
const MIGRATIONS: &[&str] = &[r#"
    CREATE TABLE chats (
        id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        data TEXT NOT NULL
    );
    -- Ordered by rowid, which upserts keep.
    CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        status TEXT,
        data TEXT NOT NULL
    );
    CREATE INDEX messages_by_chat ON messages(chat_id);
    CREATE INDEX messages_by_status ON messages(status);
"#];

pub struct Store {
    db: Mutex<Connection>,
    journal: Journal,
}

/// One turn being recorded: the prompt and the assistant message its events
/// fold into.
pub struct Turn {
    pub chat_id: String,
    pub user: Message,
    pub assistant: Message,
    last_saved: Instant,
    /// Folded changes not yet saved.
    dirty: bool,
}

impl Store {
    pub fn open(dir: impl AsRef<Path>) -> Result<Self> {
        let dir = dir.as_ref();
        std::fs::create_dir_all(dir)?;
        let db = Connection::open(dir.join("outcode.db"))?;
        db.pragma_update(None, "journal_mode", "WAL")?;
        db.pragma_update(None, "foreign_keys", true)?;
        migrate(&db)?;
        Ok(Self {
            db: Mutex::new(db),
            journal: Journal::open(dir.join("journals"))?,
        })
    }

    fn db(&self) -> MutexGuard<'_, Connection> {
        self.db.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub fn journal(&self) -> &Journal {
        &self.journal
    }

    // Chats

    pub fn create_chat(&self, cwd: impl Into<String>, config: ChatConfig) -> Result<Chat> {
        let chat = Chat {
            id: new_id(),
            title: None,
            cwd: cwd.into(),
            config,
            session_id: None,
            archived: false,
            pinned_at: None,
            created_at: now_ms(),
            last_message_at: None,
        };
        self.save_chat(&chat)?;
        Ok(chat)
    }

    pub fn save_chat(&self, chat: &Chat) -> Result<()> {
        self.db().execute(
            "INSERT INTO chats (id, created_at, data) VALUES (?1, ?2, ?3)
             ON CONFLICT(id) DO UPDATE SET data = excluded.data",
            params![chat.id, chat.created_at, serde_json::to_string(chat)?],
        )?;
        Ok(())
    }

    pub fn chat(&self, id: &str) -> Result<Option<Chat>> {
        query_one(&self.db(), "SELECT data FROM chats WHERE id = ?1", id)
    }

    /// Most recently active first.
    pub fn chats(&self) -> Result<Vec<Chat>> {
        let mut chats: Vec<Chat> = query_json(&self.db(), "SELECT data FROM chats", [])?;
        chats.sort_by_key(|c| std::cmp::Reverse(c.last_message_at.unwrap_or(c.created_at)));
        Ok(chats)
    }

    /// Deletes the chat with its messages and journal.
    pub fn delete_chat(&self, id: &str) -> Result<()> {
        self.db().execute("DELETE FROM chats WHERE id = ?1", [id])?;
        self.journal.delete(id)?;
        Ok(())
    }

    /// Applies `update` to the chat and saves it if that changed anything.
    /// Returns the chat as saved.
    pub fn update_chat(&self, id: &str, update: impl FnOnce(&mut Chat)) -> Result<Chat> {
        let mut chat = self
            .chat(id)?
            .ok_or_else(|| StoreError::NotFound(format!("chat {id}")))?;
        let before = chat.clone();
        update(&mut chat);
        if chat != before {
            self.save_chat(&chat)?;
        }
        Ok(chat)
    }

    // Messages

    /// Oldest first.
    pub fn messages(&self, chat_id: &str) -> Result<Vec<Message>> {
        query_json(
            &self.db(),
            "SELECT data FROM messages WHERE chat_id = ?1 ORDER BY rowid",
            [chat_id],
        )
    }

    pub fn message(&self, id: &str) -> Result<Option<Message>> {
        query_one(&self.db(), "SELECT data FROM messages WHERE id = ?1", id)
    }

    fn save_message(&self, chat_id: &str, message: &Message) -> Result<()> {
        let status = message.status.map(status_text).transpose()?;
        self.db().execute(
            "INSERT INTO messages (id, chat_id, status, data) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(id) DO UPDATE SET status = excluded.status, data = excluded.data",
            params![message.id, chat_id, status, serde_json::to_string(message)?],
        )?;
        Ok(())
    }

    // Turns

    /// Saves the prompt as a user message and an empty streaming assistant
    /// message for the reply; the chat is marked active (and unarchived).
    pub fn start_turn(&self, chat_id: &str, prompt: &str) -> Result<(Turn, Chat)> {
        let now = now_ms();
        let user = Message {
            id: new_id(),
            role: MessageRole::User,
            parts: vec![MessagePart::Text {
                id: "t0".into(),
                text: prompt.to_owned(),
            }],
            created_at: now,
            status: None,
            duration_ms: None,
        };
        let assistant = Message {
            id: new_id(),
            role: MessageRole::Assistant,
            parts: Vec::new(),
            created_at: now,
            status: Some(MessageStatus::Streaming),
            duration_ms: None,
        };
        let chat = self.update_chat(chat_id, |chat| {
            chat.last_message_at = Some(now);
            // New work brings an archived chat back.
            chat.archived = false;
        })?;
        self.save_message(chat_id, &user)?;
        self.save_message(chat_id, &assistant)?;
        let turn = Turn {
            chat_id: chat_id.to_owned(),
            user,
            assistant,
            last_saved: Instant::now(),
            dirty: false,
        };
        Ok((turn, chat))
    }

    /// Journals `event` and folds it into the turn's assistant message.
    /// Returns the chat when the event changed it (a new session id, the
    /// turn's end).
    pub fn record(&self, turn: &mut Turn, event: &AgentEvent) -> Result<Option<Chat>> {
        let now = now_ms();
        self.journal
            .append(&turn.chat_id, &turn.assistant.id, now, event)?;
        fold_event(&mut turn.assistant.parts, event);
        turn.dirty = true;

        let chat = match event {
            AgentEvent::SessionStarted { session_id } => {
                let before = self.chat(&turn.chat_id)?;
                let chat = self.update_chat(&turn.chat_id, |chat| {
                    chat.session_id = Some(session_id.clone())
                })?;
                (before.as_ref() != Some(&chat)).then_some(chat)
            }
            AgentEvent::Done { status } => {
                turn.assistant.status = Some(match status {
                    DoneStatus::Interrupted => MessageStatus::Aborted,
                    DoneStatus::Completed | DoneStatus::Errored => MessageStatus::Complete,
                });
                turn.assistant.duration_ms = Some(now - turn.assistant.created_at);
                Some(self.update_chat(&turn.chat_id, |chat| chat.last_message_at = Some(now))?)
            }
            _ => None,
        };

        let streaming = matches!(
            event,
            AgentEvent::TextDelta { .. } | AgentEvent::ReasoningDelta { .. }
        );
        if !streaming || turn.last_saved.elapsed() >= SAVE_INTERVAL {
            self.flush(turn)?;
        }
        Ok(chat)
    }

    /// Saves the assistant message if it has unsaved changes.
    pub fn flush(&self, turn: &mut Turn) -> Result<()> {
        if turn.dirty {
            self.save_message(&turn.chat_id, &turn.assistant)?;
            turn.dirty = false;
            turn.last_saved = Instant::now();
        }
        Ok(())
    }

    // Recovery

    /// Run once at boot, before any run starts. Closes every turn that was
    /// streaming when Outcode stopped: its message is rebuilt from the
    /// journal, ended with an error, and the journal capped with a `Done`.
    /// Returns the ids of the messages it closed.
    pub fn recover(&self) -> Result<Vec<String>> {
        let streaming: Vec<(String, String)> = {
            let db = self.db();
            let mut statement =
                db.prepare("SELECT chat_id, data FROM messages WHERE status = 'streaming'")?;
            statement
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
                .collect::<rusqlite::Result<_>>()?
        };
        let mut closed = Vec::new();
        for (chat_id, data) in streaming {
            let mut message: Message = serde_json::from_str(&data)?;
            let lines: Vec<JournalLine> = self
                .journal
                .read(&chat_id)?
                .into_iter()
                .filter(|l| l.message_id == message.id)
                .collect();
            // The journal has every event; the saved message may lag it.
            if !lines.is_empty() {
                message.parts.clear();
                for line in &lines {
                    fold_event(&mut message.parts, &line.event);
                }
            }
            let ended = lines.last().map_or(message.created_at, |l| l.at);
            let now = now_ms();
            for event in [
                AgentEvent::Error {
                    message: "Outcode closed while this turn was running.".into(),
                },
                AgentEvent::Done {
                    status: DoneStatus::Interrupted,
                },
            ] {
                self.journal.append(&chat_id, &message.id, now, &event)?;
                fold_event(&mut message.parts, &event);
            }
            message.status = Some(MessageStatus::Aborted);
            message.duration_ms = Some(ended - message.created_at);
            self.save_message(&chat_id, &message)?;
            closed.push(message.id);
        }
        Ok(closed)
    }
}

fn migrate(db: &Connection) -> Result<()> {
    let applied: i64 = db.pragma_query_value(None, "user_version", |row| row.get(0))?;
    for (version, sql) in MIGRATIONS.iter().enumerate().skip(applied as usize) {
        db.execute_batch(&format!(
            "BEGIN; {sql} PRAGMA user_version = {}; COMMIT;",
            version + 1
        ))?;
    }
    Ok(())
}

fn query_json<T: serde::de::DeserializeOwned>(
    db: &Connection,
    sql: &str,
    params: impl rusqlite::Params,
) -> Result<Vec<T>> {
    let mut statement = db.prepare(sql)?;
    let rows = statement.query_map(params, |row| row.get::<_, String>(0))?;
    let mut out = Vec::new();
    for data in rows {
        out.push(serde_json::from_str(&data?)?);
    }
    Ok(out)
}

/// The row `sql` finds by `id`, read from its JSON `data`.
fn query_one<T: serde::de::DeserializeOwned>(
    db: &Connection,
    sql: &str,
    id: &str,
) -> Result<Option<T>> {
    db.query_row(sql, [id], |row| row.get::<_, String>(0))
        .optional()?
        .map(|data| serde_json::from_str(&data).map_err(Into::into))
        .transpose()
}

/// A status as its query column holds it: its JSON string.
fn status_text(status: impl serde::Serialize) -> Result<String> {
    Ok(serde_json::to_value(status)?
        .as_str()
        .unwrap_or_default()
        .to_owned())
}

/// Locks `mutex`, carrying on past a panic in another holder.
pub(crate) fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

pub fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use outcode_proto::ToolCall;

    fn store() -> (tempfile::TempDir, Store) {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        (dir, store)
    }

    fn text(t: &str) -> AgentEvent {
        AgentEvent::TextDelta { text: t.into() }
    }

    #[test]
    fn chats_round_trip_and_sort_by_activity() {
        let (_dir, store) = store();
        let a = store.create_chat("/a", ChatConfig::default()).unwrap();
        let mut b = store.create_chat("/b", ChatConfig::default()).unwrap();
        b.created_at = a.created_at - 10;
        b.title = Some("B".into());
        store.save_chat(&b).unwrap();
        store.start_turn(&b.id, "hi").unwrap();

        let chats = store.chats().unwrap();
        assert_eq!(chats[0].id, b.id);
        assert_eq!(chats[0].title.as_deref(), Some("B"));
        assert_eq!(chats[1], a);

        store.delete_chat(&b.id).unwrap();
        assert!(store.chat(&b.id).unwrap().is_none());
        assert!(store.messages(&b.id).unwrap().is_empty());
    }

    #[test]
    fn a_turn_unarchives_its_chat() {
        let (_dir, store) = store();
        let chat = store.create_chat("/a", ChatConfig::default()).unwrap();
        store.update_chat(&chat.id, |c| c.archived = true).unwrap();
        let (_, chat) = store.start_turn(&chat.id, "hi").unwrap();
        assert!(!chat.archived);
    }

    #[test]
    fn a_recorded_turn_folds_journals_and_finishes() {
        let (_dir, store) = store();
        let chat = store.create_chat("/a", ChatConfig::default()).unwrap();
        let (mut turn, _) = store.start_turn(&chat.id, "hello").unwrap();
        let session = AgentEvent::SessionStarted {
            session_id: "s1".into(),
        };
        assert!(store.record(&mut turn, &session).unwrap().is_some());
        // The same session again changes nothing.
        assert!(store.record(&mut turn, &session).unwrap().is_none());
        for event in [
            text("Hi "),
            text("there"),
            AgentEvent::ToolCall {
                id: "t1".into(),
                call: ToolCall::Exec {
                    command: "ls".into(),
                },
            },
            AgentEvent::Done {
                status: DoneStatus::Completed,
            },
        ] {
            store.record(&mut turn, &event).unwrap();
        }

        let messages = store.messages(&chat.id).unwrap();
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0], turn.user);
        assert_eq!(messages[1], turn.assistant);
        assert_eq!(messages[1].status, Some(MessageStatus::Complete));
        assert!(
            matches!(&messages[1].parts[0], MessagePart::Text { text, .. } if text == "Hi there")
        );
        let chat = store.chat(&chat.id).unwrap().unwrap();
        assert_eq!(chat.session_id.as_deref(), Some("s1"));
        assert_eq!(store.journal().read(&chat.id).unwrap().len(), 6);
    }

    #[test]
    fn recover_rebuilds_an_interrupted_turn_from_its_journal() {
        let dir = tempfile::tempdir().unwrap();
        let message_id = {
            let store = Store::open(dir.path()).unwrap();
            let chat = store.create_chat("/a", ChatConfig::default()).unwrap();
            let (mut turn, _) = store.start_turn(&chat.id, "hello").unwrap();
            store.record(&mut turn, &text("partial ")).unwrap();
            // Within the save interval: journaled, not yet saved.
            store.record(&mut turn, &text("reply")).unwrap();
            turn.assistant.id.clone()
            // Dropped without a Done: Outcode "crashed".
        };

        let store = Store::open(dir.path()).unwrap();
        assert_eq!(store.recover().unwrap(), vec![message_id.clone()]);
        let message = store.message(&message_id).unwrap().unwrap();
        assert_eq!(message.status, Some(MessageStatus::Aborted));
        assert!(
            matches!(&message.parts[0], MessagePart::Text { text, .. } if text == "partial reply")
        );
        assert!(matches!(&message.parts[1], MessagePart::Error { .. }));
        // Idempotent: nothing left to recover.
        assert!(store.recover().unwrap().is_empty());
    }
}
