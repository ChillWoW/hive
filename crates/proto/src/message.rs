//! A transcript message and the parts an assistant turn is folded into.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::agent::ToolCall;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum MessageRole {
    User,
    Assistant,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum MessageStatus {
    Streaming,
    Complete,
    /// The user stopped it.
    Aborted,
}

/// One rendered piece of a message. An assistant turn's [`AgentEvent`]s fold
/// into these ([`crate::fold_event`]): consecutive deltas grow one
/// `text`/`reasoning` part, and a tool call in between starts a new one.
///
/// [`AgentEvent`]: crate::AgentEvent
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(optional_fields)]
pub enum MessagePart {
    Text {
        id: String,
        text: String,
    },
    Reasoning {
        id: String,
        text: String,
    },
    /// Keyed by the tool call's own id, so a `ToolResult` finds it.
    #[serde(rename_all = "camelCase")]
    Tool {
        id: String,
        call: ToolCall,
        /// A `ToolResult` arrived.
        #[serde(default)]
        resolved: bool,
        #[serde(default)]
        is_error: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        output: Option<String>,
    },
    Error {
        id: String,
        message: String,
    },
}

impl MessagePart {
    pub fn id(&self) -> &str {
        match self {
            MessagePart::Text { id, .. }
            | MessagePart::Reasoning { id, .. }
            | MessagePart::Tool { id, .. }
            | MessagePart::Error { id, .. } => id,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct Message {
    pub id: String,
    pub role: MessageRole,
    pub parts: Vec<MessagePart>,
    /// Epoch millis.
    pub created_at: i64,
    /// Assistant messages only; user messages are always complete.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<MessageStatus>,
    /// Wall-clock length of the assistant turn, set once it finishes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<i64>,
}
