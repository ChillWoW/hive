//! hive-store — Hive's durable state, under one data directory:
//!
//! - `hive.db` (SQLite): chats, messages and the command ledger. Each row
//!   keeps the proto type as JSON, plus the columns queries need.
//! - `journals/{chatId}.jsonl`: every event of every run, as it arrived
//!   (see [`journal`]).
//!
//! A turn is recorded through [`Store::start_turn`] and [`Store::record`]:
//! each event is journaled, folded into the assistant message, and the
//! message saved (at most once a second while text streams). After a crash,
//! [`Store::recover`] rebuilds unfinished messages from their journals.

pub mod journal;
pub mod settings;

use std::path::Path;
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use hive_proto::{
    fold_event, AgentEvent, Chat, ChatConfig, Command, CommandPayload, CommandStatus, DoneStatus,
    Message, MessagePart, MessageRole, MessageStatus,
};
use rusqlite::{params, Connection, OptionalExtension};

pub use journal::{Journal, JournalLine};
pub use settings::{SettingsFile, SETTINGS_FILE};

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
    CREATE TABLE commands (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        data TEXT NOT NULL
    );
    CREATE INDEX commands_by_chat ON commands(chat_id);
    CREATE INDEX commands_by_status ON commands(status);
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

/// What [`Store::recover`] cleaned up.
#[derive(Debug, Default, PartialEq)]
pub struct Recovery {
    pub expired_commands: usize,
    pub aborted_messages: Vec<String>,
}

impl Store {
    pub fn open(dir: impl AsRef<Path>) -> Result<Self> {
        let dir = dir.as_ref();
        std::fs::create_dir_all(dir)?;
        let db = Connection::open(dir.join("hive.db"))?;
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
            harness_session_id: None,
            archived: false,
            created_at: now_ms(),
            last_message_at: None,
            last_seen_at: None,
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
        self.db()
            .query_row("SELECT data FROM chats WHERE id = ?1", [id], |row| {
                row.get::<_, String>(0)
            })
            .optional()?
            .map(|data| serde_json::from_str(&data).map_err(Into::into))
            .transpose()
    }

    /// Most recently active first.
    pub fn chats(&self) -> Result<Vec<Chat>> {
        let mut chats: Vec<Chat> = query_json(&self.db(), "SELECT data FROM chats", [])?;
        chats.sort_by_key(|c| std::cmp::Reverse(c.last_message_at.unwrap_or(c.created_at)));
        Ok(chats)
    }

    /// Deletes the chat with its messages, commands and journal.
    pub fn delete_chat(&self, id: &str) -> Result<()> {
        self.db().execute("DELETE FROM chats WHERE id = ?1", [id])?;
        self.journal.delete(id)
    }

    fn update_chat(&self, id: &str, update: impl FnOnce(&mut Chat)) -> Result<()> {
        let mut chat = self
            .chat(id)?
            .ok_or_else(|| StoreError::NotFound(format!("chat {id}")))?;
        update(&mut chat);
        self.save_chat(&chat)
    }

    // Messages

    pub fn messages(&self, chat_id: &str) -> Result<Vec<Message>> {
        query_json(
            &self.db(),
            "SELECT data FROM messages WHERE chat_id = ?1 ORDER BY rowid",
            [chat_id],
        )
    }

    pub fn message(&self, id: &str) -> Result<Option<Message>> {
        self.db()
            .query_row("SELECT data FROM messages WHERE id = ?1", [id], |row| {
                row.get::<_, String>(0)
            })
            .optional()?
            .map(|data| serde_json::from_str(&data).map_err(Into::into))
            .transpose()
    }

    pub fn save_message(&self, message: &Message) -> Result<()> {
        let status = message
            .status
            .map(|s| serde_json::to_value(s).map(|v| v.as_str().unwrap_or_default().to_owned()))
            .transpose()?;
        self.db().execute(
            "INSERT INTO messages (id, chat_id, status, data) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(id) DO UPDATE SET status = excluded.status, data = excluded.data",
            params![
                message.id,
                message.chat_id,
                status,
                serde_json::to_string(message)?
            ],
        )?;
        Ok(())
    }

    // Commands

    pub fn issue_command(&self, chat_id: &str, payload: CommandPayload) -> Result<Command> {
        let command = Command {
            id: new_id(),
            chat_id: chat_id.to_owned(),
            payload,
            status: CommandStatus::Pending,
            issued_at: now_ms(),
            resolved_at: None,
            resolution: None,
        };
        self.save_command(&command)?;
        Ok(command)
    }

    /// Records a pending command's outcome. Settled commands don't change.
    pub fn resolve_command(
        &self,
        id: &str,
        status: CommandStatus,
        resolution: Option<String>,
    ) -> Result<Command> {
        let mut command: Command = self
            .db()
            .query_row("SELECT data FROM commands WHERE id = ?1", [id], |row| {
                row.get::<_, String>(0)
            })
            .optional()?
            .map(|data| serde_json::from_str(&data))
            .transpose()?
            .ok_or_else(|| StoreError::NotFound(format!("command {id}")))?;
        if command.status == CommandStatus::Pending {
            command.status = status;
            command.resolved_at = Some(now_ms());
            command.resolution = resolution;
            self.save_command(&command)?;
        }
        Ok(command)
    }

    /// Oldest first.
    pub fn commands(&self, chat_id: &str) -> Result<Vec<Command>> {
        query_json(
            &self.db(),
            "SELECT data FROM commands WHERE chat_id = ?1 ORDER BY rowid",
            [chat_id],
        )
    }

    fn save_command(&self, command: &Command) -> Result<()> {
        let status = serde_json::to_value(command.status)?;
        self.db().execute(
            "INSERT INTO commands (id, chat_id, status, data) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(id) DO UPDATE SET status = excluded.status, data = excluded.data",
            params![
                command.id,
                command.chat_id,
                status.as_str(),
                serde_json::to_string(command)?
            ],
        )?;
        Ok(())
    }

    // Turns

    /// Saves the prompt as a user message and an empty streaming assistant
    /// message for the reply. `user_message_id` is the id the issuer minted
    /// (see [`CommandPayload::Send`]); `None` mints one.
    pub fn start_turn(
        &self,
        chat_id: &str,
        prompt: &str,
        user_message_id: Option<String>,
    ) -> Result<Turn> {
        let now = now_ms();
        let user = Message {
            id: user_message_id.unwrap_or_else(new_id),
            chat_id: chat_id.to_owned(),
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
            chat_id: chat_id.to_owned(),
            role: MessageRole::Assistant,
            parts: Vec::new(),
            created_at: now,
            status: Some(MessageStatus::Streaming),
            duration_ms: None,
        };
        self.update_chat(chat_id, |chat| chat.last_message_at = Some(now))?;
        self.save_message(&user)?;
        self.save_message(&assistant)?;
        Ok(Turn {
            chat_id: chat_id.to_owned(),
            user,
            assistant,
            last_saved: Instant::now(),
            dirty: false,
        })
    }

    /// Journals `event` and folds it into the turn's assistant message.
    /// Events after the turn's `Done` (a background subagent finishing)
    /// still fold in.
    pub fn record(&self, turn: &mut Turn, event: &AgentEvent) -> Result<()> {
        let now = now_ms();
        self.journal
            .append(&turn.chat_id, &turn.assistant.id, now, event)?;
        fold_event(&mut turn.assistant.parts, event);
        turn.dirty = true;

        match event {
            AgentEvent::SessionStarted { session_id, .. } => {
                let session_id = session_id.clone();
                self.update_chat(&turn.chat_id, |chat| {
                    chat.harness_session_id = Some(session_id)
                })?;
            }
            AgentEvent::Done {
                status, session_id, ..
            } => {
                turn.assistant.status = Some(match status {
                    DoneStatus::Interrupted => MessageStatus::Aborted,
                    DoneStatus::Completed | DoneStatus::Errored => MessageStatus::Complete,
                });
                turn.assistant.duration_ms = Some(now - turn.assistant.created_at);
                let session_id = session_id.clone();
                self.update_chat(&turn.chat_id, |chat| {
                    chat.last_message_at = Some(now);
                    if session_id.is_some() {
                        chat.harness_session_id = session_id;
                    }
                })?;
            }
            _ => {}
        }

        let streaming = matches!(
            event,
            AgentEvent::TextDelta { .. } | AgentEvent::ReasoningDelta { .. }
        );
        if !streaming || turn.last_saved.elapsed() >= SAVE_INTERVAL {
            self.flush(turn)?;
        }
        Ok(())
    }

    /// Saves the assistant message if it has unsaved changes.
    pub fn flush(&self, turn: &mut Turn) -> Result<()> {
        if turn.dirty {
            self.save_message(&turn.assistant)?;
            turn.dirty = false;
            turn.last_saved = Instant::now();
        }
        Ok(())
    }

    // Recovery

    /// Run once at boot, before any run starts. Expires commands that never
    /// ran, and closes every turn that was streaming when Hive stopped: its
    /// message is rebuilt from the journal, ended with an error, and the
    /// journal capped with a matching `Done`.
    pub fn recover(&self) -> Result<Recovery> {
        let mut recovery = Recovery::default();

        let pending: Vec<Command> = query_json(
            &self.db(),
            "SELECT data FROM commands WHERE status = 'pending'",
            [],
        )?;
        for command in pending {
            self.resolve_command(
                &command.id,
                CommandStatus::Expired,
                Some("Hive stopped before this command ran.".into()),
            )?;
            recovery.expired_commands += 1;
        }

        let streaming: Vec<Message> = query_json(
            &self.db(),
            "SELECT data FROM messages WHERE status = 'streaming'",
            [],
        )?;
        for mut message in streaming {
            let lines: Vec<JournalLine> = self
                .journal
                .read(&message.chat_id)?
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
            let done = AgentEvent::Done {
                status: DoneStatus::Interrupted,
                error: Some("Hive closed while this turn was running.".into()),
                session_id: None,
            };
            self.journal
                .append(&message.chat_id, &message.id, now_ms(), &done)?;
            fold_event(&mut message.parts, &done);
            message.status = Some(MessageStatus::Aborted);
            message.duration_ms = Some(ended - message.created_at);
            self.save_message(&message)?;
            recovery.aborted_messages.push(message.id);
        }
        Ok(recovery)
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
    use hive_proto::{HarnessId, SandboxLevel, ToolCall, UserInputAnswer};

    fn config() -> ChatConfig {
        ChatConfig {
            harness: HarnessId::ClaudeCode,
            model: None,
            reasoning: None,
            model_options: Default::default(),
            sandbox: SandboxLevel::WorkspaceWrite,
            access: Default::default(),
            plan: false,
        }
    }

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
        let a = store.create_chat("/a", config()).unwrap();
        let mut b = store.create_chat("/b", config()).unwrap();
        b.created_at = a.created_at - 10;
        b.title = Some("B".into());
        store.save_chat(&b).unwrap();
        store.start_turn(&b.id, "hi", None).unwrap();

        let chats = store.chats().unwrap();
        assert_eq!(chats[0].id, b.id);
        assert_eq!(chats[0].title.as_deref(), Some("B"));
        assert_eq!(chats[1], a);

        store.delete_chat(&b.id).unwrap();
        assert!(store.chat(&b.id).unwrap().is_none());
        assert!(store.messages(&b.id).unwrap().is_empty());
    }

    #[test]
    fn a_recorded_turn_folds_journals_and_finishes() {
        let (_dir, store) = store();
        let chat = store.create_chat("/a", config()).unwrap();
        let mut turn = store
            .start_turn(&chat.id, "hello", Some("u1".into()))
            .unwrap();
        for event in [
            AgentEvent::SessionStarted {
                harness: HarnessId::ClaudeCode,
                model: "m".into(),
                cwd: "/a".into(),
                session_id: "s1".into(),
                tools: vec![],
            },
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
                error: None,
                session_id: Some("s1".into()),
            },
        ] {
            store.record(&mut turn, &event).unwrap();
        }

        let messages = store.messages(&chat.id).unwrap();
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].id, "u1");
        assert_eq!(messages[1], turn.assistant);
        assert_eq!(messages[1].status, Some(MessageStatus::Complete));
        assert!(
            matches!(&messages[1].parts[0], MessagePart::Text { text, .. } if text == "Hi there")
        );
        assert_eq!(
            store
                .chat(&chat.id)
                .unwrap()
                .unwrap()
                .harness_session_id
                .as_deref(),
            Some("s1")
        );
        assert_eq!(store.journal().read(&chat.id).unwrap().len(), 5);
    }

    #[test]
    fn commands_settle_once() {
        let (_dir, store) = store();
        let chat = store.create_chat("/a", config()).unwrap();
        let command = store
            .issue_command(
                &chat.id,
                CommandPayload::Answer {
                    request_id: "q".into(),
                    answers: vec![UserInputAnswer {
                        question_id: "a".into(),
                        labels: vec!["Yes".into()],
                    }],
                },
            )
            .unwrap();
        let applied = store
            .resolve_command(&command.id, CommandStatus::Applied, None)
            .unwrap();
        assert_eq!(applied.status, CommandStatus::Applied);
        let again = store
            .resolve_command(&command.id, CommandStatus::Rejected, Some("late".into()))
            .unwrap();
        assert_eq!(again.status, CommandStatus::Applied);
        assert_eq!(store.commands(&chat.id).unwrap(), vec![applied]);
    }

    #[test]
    fn recover_rebuilds_an_interrupted_turn_from_its_journal() {
        let dir = tempfile::tempdir().unwrap();
        let (chat_id, message_id) = {
            let store = Store::open(dir.path()).unwrap();
            let chat = store.create_chat("/a", config()).unwrap();
            store
                .issue_command(&chat.id, CommandPayload::Interrupt)
                .unwrap();
            let mut turn = store.start_turn(&chat.id, "hello", None).unwrap();
            store.record(&mut turn, &text("partial ")).unwrap();
            // Within the save interval: journaled, not yet saved.
            store.record(&mut turn, &text("reply")).unwrap();
            (chat.id, turn.assistant.id.clone())
            // Dropped without a Done: Hive "crashed".
        };

        let store = Store::open(dir.path()).unwrap();
        let recovery = store.recover().unwrap();
        assert_eq!(
            recovery,
            Recovery {
                expired_commands: 1,
                aborted_messages: vec![message_id.clone()],
            }
        );
        let message = store.message(&message_id).unwrap().unwrap();
        assert_eq!(message.status, Some(MessageStatus::Aborted));
        assert!(
            matches!(&message.parts[0], MessagePart::Text { text, .. } if text == "partial reply")
        );
        assert!(matches!(&message.parts[1], MessagePart::Error { .. }));
        assert_eq!(
            store.commands(&chat_id).unwrap()[0].status,
            CommandStatus::Expired
        );
        // Idempotent: nothing left to recover.
        assert_eq!(store.recover().unwrap(), Recovery::default());
    }
}
