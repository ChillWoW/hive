//! What goes into a harness and what comes back out: the run request and the
//! normalized event stream every CLI driver translates its own output into.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

/// Which coding-agent CLI drives a run.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum HarnessId {
    /// `claude` with `--input-format stream-json --output-format stream-json`.
    ClaudeCode,
    /// `codex app-server`.
    Codex,
    /// `opencode serve`.
    Opencode,
    /// Scripted in-process harness for tests and UI work; never in pickers.
    Mock,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum ReasoningLevel {
    Minimal,
    Low,
    Medium,
    High,
    XHigh,
    Max,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum SandboxLevel {
    ReadOnly,
    WorkspaceWrite,
    DangerFullAccess,
}

/// A model a harness offers, as the model picker shows it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct Model {
    pub id: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default)]
    pub reasoning_levels: Vec<ReasoningLevel>,
    /// Harness-specific knobs beyond reasoning (e.g. Codex's service tier).
    #[serde(default)]
    pub options: Vec<ModelOption>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ModelOption {
    pub id: String,
    pub label: String,
    pub choices: Vec<ModelOptionChoice>,
    pub default_choice: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ModelOptionChoice {
    pub id: String,
    pub label: String,
}

/// Everything a harness needs to start (or resume) one turn.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct RunRequest {
    pub harness: HarnessId,
    pub prompt: String,
    pub cwd: String,
    pub sandbox: SandboxLevel,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<ReasoningLevel>,
    /// Selections for [`Model::options`]: option id -> choice id.
    #[serde(default)]
    pub model_options: BTreeMap<String, String>,
    #[serde(default)]
    pub auto_approve: bool,
    /// Harness-native session id to continue, from an earlier
    /// [`AgentEvent::SessionStarted`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resume: Option<String>,
    /// Absolute paths of image attachments.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[ts(as = "Option<Vec<String>>")]
    pub attachments: Vec<String>,
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
    ApplyPatch {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        path: Option<String>,
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
    /// A subagent spawn (Claude's `Task`/`Agent`, Codex's spawn tool).
    /// Its own traffic arrives as [`AgentEvent::Subagent`] keyed by this
    /// call's id.
    Subagent {
        description: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        model: Option<String>,
    },
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum TodoStatus {
    #[default]
    Pending,
    InProgress,
    Completed,
}

impl TodoStatus {
    /// Decode a harness status string. Anything unrecognised (including
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

/// A file change carried on a tool result. `old_text: None` means a new file.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ToolDiff {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub old_text: Option<String>,
    pub new_text: String,
}

/// A slash command the agent advertises, typed as `/name` in the composer.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct SlashCommand {
    pub name: String,
    #[serde(default)]
    pub description: String,
    /// Placeholder for the command's argument, when it takes one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_hint: Option<String>,
}

/// One question in an agent's request for user input (Claude's
/// `AskUserQuestion`, Codex's elicitation).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct UserInputQuestion {
    pub id: String,
    pub header: String,
    pub question: String,
    pub options: Vec<String>,
    #[serde(default)]
    pub multi_select: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct UserInputAnswer {
    pub question_id: String,
    pub labels: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum DoneStatus {
    Completed,
    Interrupted,
    Errored,
}

/// The normalized streaming event every harness emits.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
#[ts(optional_fields)]
pub enum AgentEvent {
    #[serde(rename_all = "camelCase")]
    SessionStarted {
        harness: HarnessId,
        model: String,
        cwd: String,
        /// Harness-native session id; pass back as [`RunRequest::resume`].
        session_id: String,
        #[serde(default)]
        tools: Vec<String>,
    },
    TextDelta {
        text: String,
    },
    ReasoningDelta {
        text: String,
    },
    ToolCall {
        id: String,
        call: ToolCall,
    },
    #[serde(rename_all = "camelCase")]
    ToolResult {
        id: String,
        is_error: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        output: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        diff: Option<ToolDiff>,
    },
    #[serde(rename_all = "camelCase")]
    InputRequested {
        request_id: String,
        questions: Vec<UserInputQuestion>,
    },
    #[serde(rename_all = "camelCase")]
    InputResolved {
        request_id: String,
    },
    /// Current context-window occupancy. A missing field keeps the previous
    /// value.
    ContextUsage {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tokens: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        window: Option<u64>,
    },
    /// Cumulative billing tokens for the turn.
    #[serde(rename_all = "camelCase")]
    Usage {
        input_tokens: u64,
        output_tokens: u64,
    },
    AvailableCommands {
        commands: Vec<SlashCommand>,
    },
    /// A non-fatal error the run continues past; fatal ones end in
    /// [`AgentEvent::Done`] with `status: errored`.
    Error {
        message: String,
    },
    /// An event from a subagent's own transcript, attributed to the
    /// [`ToolCall::Subagent`] call that spawned it.
    #[serde(rename_all = "camelCase")]
    Subagent {
        parent_tool_id: String,
        event: Box<AgentEvent>,
    },
    #[serde(rename_all = "camelCase")]
    Done {
        status: DoneStatus,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        session_id: Option<String>,
    },
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn agent_event_wire_shape() {
        let ev = AgentEvent::ToolCall {
            id: "t1".into(),
            call: ToolCall::EditFile {
                path: "src/main.rs".into(),
                old_string: None,
                new_string: Some("fn main() {}".into()),
            },
        };
        let value = serde_json::to_value(&ev).unwrap();
        assert_eq!(
            value,
            json!({
                "type": "toolCall",
                "id": "t1",
                "call": { "kind": "editFile", "path": "src/main.rs", "newString": "fn main() {}" }
            })
        );
        assert_eq!(serde_json::from_value::<AgentEvent>(value).unwrap(), ev);
    }

    #[test]
    fn nested_subagent_event_round_trips() {
        let ev = AgentEvent::Subagent {
            parent_tool_id: "t1".into(),
            event: Box::new(AgentEvent::TextDelta { text: "hi".into() }),
        };
        let value = serde_json::to_value(&ev).unwrap();
        assert_eq!(value["parentToolId"], "t1");
        assert_eq!(value["event"]["type"], "textDelta");
        assert_eq!(serde_json::from_value::<AgentEvent>(value).unwrap(), ev);
    }

    #[test]
    fn run_request_defaults_optional_fields() {
        let req: RunRequest = serde_json::from_value(json!({
            "harness": "claude-code",
            "prompt": "p",
            "cwd": ".",
            "sandbox": "workspace-write",
        }))
        .unwrap();
        assert!(req.model.is_none() && req.attachments.is_empty() && !req.auto_approve);
        let value = serde_json::to_value(&req).unwrap();
        assert!(value.get("attachments").is_none());
        assert!(value.get("model").is_none());
    }

    #[test]
    fn enum_spellings() {
        assert_eq!(json!(HarnessId::ClaudeCode), "claude-code");
        assert_eq!(json!(ReasoningLevel::XHigh), "xhigh");
        assert_eq!(json!(TodoStatus::InProgress), "inProgress");
    }

    #[test]
    fn todo_status_parses_harness_strings() {
        assert_eq!(TodoStatus::parse("in_progress"), TodoStatus::InProgress);
        assert_eq!(TodoStatus::parse("done"), TodoStatus::Completed);
        assert_eq!(TodoStatus::parse("cancelled"), TodoStatus::Pending);
    }
}
