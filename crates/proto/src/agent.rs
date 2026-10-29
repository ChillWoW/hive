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

/// How much an agent may do before it has to ask. Each harness maps the mode
/// onto its own approval policy and lists the modes it can honor
/// (`HarnessCatalog::access_modes`); whatever a run must still ask reaches the
/// user as a yes/no question.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum AccessMode {
    /// Ask before commands and file changes.
    Supervised,
    /// Apply file changes without asking; ask before anything else.
    AutoAcceptEdits,
    /// Run commands and change files without asking.
    #[default]
    FullAccess,
}

impl AccessMode {
    /// Every mode, least to most trusting (the picker's order).
    pub const ALL: [AccessMode; 3] = [
        AccessMode::Supervised,
        AccessMode::AutoAcceptEdits,
        AccessMode::FullAccess,
    ];

    pub fn is_full_access(&self) -> bool {
        *self == AccessMode::FullAccess
    }
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
    /// Skip every check, the CLI's own included. Stronger than full access.
    #[serde(default)]
    pub auto_approve: bool,
    /// What the agent may do without asking.
    #[serde(default)]
    pub access: AccessMode,
    /// Plan mode: the agent explores and proposes a plan instead of changing
    /// anything. Honored by harnesses whose catalog says so.
    #[serde(default)]
    pub plan: bool,
    /// Harness-native session id to continue, from an earlier
    /// [`AgentEvent::SessionStarted`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resume: Option<String>,
    /// Absolute paths of files sent with the prompt.
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

/// A command the agent advertises: typed as `/name` at the start of the
/// composer, or `$name` anywhere for a skill.
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
    #[serde(default)]
    pub kind: CommandKind,
}

/// Whether a [`SlashCommand`] is one of the CLI's own commands or a skill.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum CommandKind {
    #[default]
    Command,
    Skill,
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

/// Work the agent left running in the background: a subagent, a shell
/// command, a monitor. Lives until it ends or is stopped, across turns.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct BackgroundTask {
    /// The harness's task id: what stopping it or reading its output names.
    pub id: String,
    pub kind: BackgroundTaskKind,
    pub description: String,
    /// The tool call that started it, once known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    /// The background task that launched this one (a subagent's shell).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    /// A subagent's type (`general-purpose`, a custom agent's name).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_type: Option<String>,
    /// Epoch millis the engine first saw it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum BackgroundTaskKind {
    Agent,
    Shell,
    Monitor,
    Workflow,
    Other,
}

impl BackgroundTaskKind {
    /// Whether its output can be read ([`TaskOutput`]).
    pub fn has_output(self) -> bool {
        matches!(self, Self::Shell | Self::Monitor)
    }
}

/// The end of a background shell's output.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TaskOutput {
    /// The last few KiB the command wrote, escape sequences included.
    pub output: String,
    pub total_bytes: u64,
    /// `output` is only the end of a longer output.
    pub truncated: bool,
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
    /// Every background task the session holds now (agents, shells,
    /// monitors), replacing the last set. Session state, not transcript: the
    /// engine keeps it on [`crate::Session::background`] and never records it.
    BackgroundTasks {
        tasks: Vec<BackgroundTask>,
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
