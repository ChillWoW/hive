//! What the engine streams to a watcher: a snapshot first, then updates.
//! Updates apply in the order sent; a watcher that misses one can't catch
//! up, it watches again for a fresh snapshot.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::agent::AgentEvent;
use crate::chat::{Chat, Session};
use crate::command::Command;
use crate::message::Message;

/// One chat's transcript.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum MessagesUpdate {
    /// The transcript so far (the streaming reply included, as folded up to
    /// now) and the chat's pending commands: prompts queued behind the
    /// running turn.
    Snapshot {
        messages: Vec<Message>,
        pending: Vec<Command>,
    },
    /// A message added or replaced whole: a turn's prompt and its empty
    /// reply when the turn starts, the reply again when it finishes.
    Message { message: Message },
    /// Fold into message `message_id` (`foldEvent`).
    #[serde(rename_all = "camelCase")]
    Event {
        message_id: String,
        event: AgentEvent,
    },
    /// A command issued or settled.
    Command { command: Command },
}

/// The chat list and which chats have a live session.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
#[ts(optional_fields)]
pub enum ChatsUpdate {
    /// Every chat, most recently active first, and every live session.
    Snapshot {
        chats: Vec<Chat>,
        sessions: Vec<Session>,
    },
    /// A chat added or changed.
    Chat { chat: Chat },
    /// A chat's session changed; `None` once its harness process is gone.
    #[serde(rename_all = "camelCase")]
    Session {
        chat_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        session: Option<Session>,
    },
}
