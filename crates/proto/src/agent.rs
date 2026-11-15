//! What goes into a harness and what comes back out: the run request and the
//! normalized event stream every CLI driver translates its own output into.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

/// What starts a run: a prompt for an agent working in `cwd`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RunRequest {
    /// The folder the agent works in. Empty: the user's home folder.
    pub cwd: String,
    pub prompt: String,
}

/// A decoded tool invocation, reduced to the fields each kind renders.
/// Anything a driver can't map lands in `Unknown` with its raw input.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(optional_fields)]
pub enum ToolCall {
    Exec {
        command: String,
    },
    ReadFile {
        path: String,
    },
    WriteFile {
        path: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        content: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    EditFile {
        path: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        old_string: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        new_string: Option<String>,
    },
    Search {
        pattern: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        path: Option<String>,
    },
    Glob {
        pattern: String,
    },
    WebFetch {
        url: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        prompt: Option<String>,
    },
    WebSearch {
        query: String,
    },
    Todo {
        items: Vec<TodoItem>,
    },
    /// A tool of an MCP server.
    Mcp {
        server: String,
        tool: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        input: Option<Value>,
    },
    Unknown {
        name: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        input: Option<Value>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum TodoStatus {
    #[default]
    Pending,
    InProgress,
    Completed,
}

impl TodoStatus {
    /// Decodes a harness status string. Anything unrecognised (including
    /// `cancelled`) is `Pending`: not finished, not being worked on.
    pub fn parse(raw: &str) -> Self {
        match raw {
            "completed" | "complete" | "done" => Self::Completed,
            "in_progress" | "inProgress" | "in-progress" | "active" => Self::InProgress,
            _ => Self::Pending,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct TodoItem {
    pub text: String,
    pub status: TodoStatus,
}

/// How a turn ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum DoneStatus {
    Completed,
    /// Stopped by the user.
    Interrupted,
    /// Failed; an [`AgentEvent::Error`] said why.
    Errored,
}

/// One step of an agent's turn, normalized across CLIs. A turn ends with
/// [`AgentEvent::Done`]; a failed one reports [`AgentEvent::Error`] first.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
#[ts(optional_fields)]
pub enum AgentEvent {
    /// More of the reply's text, to append.
    TextDelta { text: String },
    /// More of the agent's thinking, to append.
    ReasoningDelta { text: String },
    /// A tool call started. The same id again refreshes it (a todo list).
    ToolCall { id: String, call: ToolCall },
    /// The call `id` finished.
    ToolResult {
        id: String,
        is_error: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        output: Option<String>,
    },
    Error { message: String },
    Done { status: DoneStatus },
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn wire_shape() {
        let event = AgentEvent::ToolCall {
            id: "t1".into(),
            call: ToolCall::EditFile {
                path: "src/main.rs".into(),
                old_string: None,
                new_string: Some("fn main() {}".into()),
            },
        };
        let value = serde_json::to_value(&event).unwrap();
        assert_eq!(
            value,
            json!({
                "type": "toolCall",
                "id": "t1",
                "call": { "kind": "editFile", "path": "src/main.rs", "newString": "fn main() {}" }
            })
        );
        assert_eq!(serde_json::from_value::<AgentEvent>(value).unwrap(), event);

        let result = AgentEvent::ToolResult {
            id: "t1".into(),
            is_error: true,
            output: None,
        };
        assert_eq!(
            serde_json::to_value(&result).unwrap(),
            json!({ "type": "toolResult", "id": "t1", "isError": true })
        );
    }

    #[test]
    fn todo_status_parses_harness_strings() {
        assert_eq!(TodoStatus::parse("in_progress"), TodoStatus::InProgress);
        assert_eq!(TodoStatus::parse("done"), TodoStatus::Completed);
        assert_eq!(TodoStatus::parse("cancelled"), TodoStatus::Pending);
    }
}
