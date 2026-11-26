//! A transcript message and the parts an assistant turn is folded into.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::agent::{CompactionStatus, FinishedTask, InputRequest, InputResponse, ToolCall};

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

/// Where a spawned subagent stands, shown on its spawn row.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum SubagentStatus {
    Running,
    Done,
    Failed,
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
        /// Subagent spawns only. Apart from `resolved`: the spawn's own
        /// result can land while the subagent still runs in the background.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        subagent: Option<SubagentStatus>,
        /// Subagent spawns only: the subagent's own transcript, folded from
        /// its `AgentEvent::Subagent` events.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        #[ts(as = "Option<Vec<MessagePart>>", optional)]
        thread: Vec<MessagePart>,
        /// Subagent spawns only: epoch millis it was spawned and its `Done`
        /// came, stamped by [`crate::stamp_event`] (folding has no clock),
        /// so how long it took outlives the run.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        started_at: Option<i64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        ended_at: Option<i64>,
    },
    /// The agent asked the user something; `response` once answered.
    #[serde(rename_all = "camelCase")]
    Input {
        id: String,
        request_id: String,
        request: InputRequest,
        #[serde(default)]
        resolved: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        response: Option<InputResponse>,
    },
    /// A context compaction: a divider in the transcript.
    #[serde(rename_all = "camelCase")]
    Compaction {
        id: String,
        status: CompactionStatus,
        #[serde(default)]
        auto: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        before_tokens: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        after_tokens: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    /// Opens a reply the agent started on its own, naming the background
    /// tasks whose ending woke it.
    Wake {
        id: String,
        finished: Vec<FinishedTask>,
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
            | MessagePart::Input { id, .. }
            | MessagePart::Compaction { id, .. }
            | MessagePart::Wake { id, .. }
            | MessagePart::Error { id, .. } => id,
        }
    }
}

/// A file sent with a prompt. Outcode keeps its own copy, so the message
/// still has it after the original moves.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    /// Absolute path of Outcode's copy.
    pub path: String,
    /// The file's name as it was attached.
    pub name: String,
    pub mime_type: String,
    /// Bytes.
    pub size: u64,
}

impl Attachment {
    pub fn is_image(&self) -> bool {
        self.mime_type.starts_with("image/")
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct Message {
    pub id: String,
    pub role: MessageRole,
    pub parts: Vec<MessagePart>,
    /// User messages only: files sent with the prompt.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[ts(as = "Option<Vec<Attachment>>")]
    pub attachments: Vec<Attachment>,
    /// Epoch millis.
    pub created_at: i64,
    /// Assistant messages only; user messages are always complete.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<MessageStatus>,
    /// Wall-clock length of the assistant turn, set once it finishes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<i64>,
}
