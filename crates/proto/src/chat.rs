//! Chats, and the updates their watchers get.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::agent::AgentEvent;
use crate::message::Message;
use crate::model::ChatConfig;

/// A conversation with an agent in one folder.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct Chat {
    pub id: String,
    /// The user's name for it; untitled until renamed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// The folder the agent works in.
    pub cwd: String,
    /// The model and effort its turns run on.
    #[serde(default)]
    pub config: ChatConfig,
    /// The CLI's own session id, resumed by the next run so the agent keeps
    /// the conversation (`RunRequest::resume`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// Listed under the sidebar's Archived section; a new turn brings it back.
    #[serde(default)]
    pub archived: bool,
    /// Epoch millis of the pin; pinned chats are listed first, in pin order.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pinned_at: Option<i64>,
    /// Epoch millis.
    pub created_at: i64,
    /// Epoch millis of the latest prompt or reply.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_message_at: Option<i64>,
}

/// What a `watch_chats` watcher hears: every chat once, then each change.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ChatsUpdate {
    /// Every chat, most recently active first, and the ids of those whose
    /// turn is running.
    Snapshot { chats: Vec<Chat>, working: Vec<String> },
    /// A chat created or changed.
    Upsert { chat: Chat },
    Removed { id: String },
    /// A chat's turn started (`working`) or ended.
    Working { chat_id: String, working: bool },
}

/// What a `watch_messages` watcher hears about one chat: its messages once,
/// then each change.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum MessagesUpdate {
    /// Every message, oldest first; a reply being written as far as it got.
    Snapshot { messages: Vec<Message> },
    /// A message added, or a reply settled (its status and duration set).
    Upsert { message: Message },
    /// An event the streaming reply `message_id` folds in (`fold_event`).
    Event { message_id: String, event: AgentEvent },
}
