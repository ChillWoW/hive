//! A transcript message and the parts an assistant turn is folded into.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::agent::{ToolCall, ToolDiff, UserInputQuestion};

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
    Aborted,
}

/// Lifecycle of a spawned subagent, shown on its spawn chip.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum SubagentStatus {
    Running,
    Done,
    Failed,
}

/// One rendered piece of a message. An assistant turn's [`AgentEvent`]s fold
/// into these: consecutive deltas grow one `text`/`reasoning` part, and a
/// tool call in between starts a new one.
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
        #[serde(default, skip_serializing_if = "Option::is_none")]
        diff: Option<ToolDiff>,
        /// Only on `ToolCall::Subagent` calls. Separate from `resolved`: the
        /// spawn's own result can land while the subagent still runs.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        subagent: Option<SubagentStatus>,
    },
    #[serde(rename_all = "camelCase")]
    Input {
        id: String,
        request_id: String,
        questions: Vec<UserInputQuestion>,
        #[serde(default)]
        resolved: bool,
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
            | MessagePart::Error { id, .. } => id,
        }
    }
}

/// A file sent with a prompt. Hive keeps its own copy, so the message
/// still has it after the original moves.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    /// Absolute path of Hive's copy.
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
    pub chat_id: String,
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn tool_part_omits_empty_optionals() {
        let part = MessagePart::Tool {
            id: "t1".into(),
            call: ToolCall::Exec {
                command: "ls".into(),
            },
            resolved: false,
            is_error: false,
            output: None,
            diff: None,
            subagent: None,
        };
        assert_eq!(
            serde_json::to_value(&part).unwrap(),
            json!({
                "kind": "tool",
                "id": "t1",
                "call": { "kind": "exec", "command": "ls" },
                "resolved": false,
                "isError": false,
            })
        );
    }
}
