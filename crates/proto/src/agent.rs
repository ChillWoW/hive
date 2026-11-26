//! What goes into a harness and what comes back out: the run request and the
//! normalized event stream every CLI driver translates its own output into.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

use crate::model::ChatConfig;

/// What starts a run: a prompt for an agent working in `cwd`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct RunRequest {
    /// The folder the agent works in. Empty: the user's home folder.
    pub cwd: String,
    pub prompt: String,
    /// Absolute paths of files sent with the prompt.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[ts(as = "Option<Vec<String>>")]
    pub attachments: Vec<String>,
    /// A session to pick up (the CLI's own id, from [`AgentEvent::SessionStarted`]),
    /// so the agent remembers the chat so far.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resume: Option<String>,
    /// Model, effort, options, access and plan mode; unset ones are the CLI's own.
    #[serde(default)]
    pub config: ChatConfig,
    /// The context size, in tokens, the agent compacts its conversation at
    /// (Claude Code's `autoCompactWindow`); None keeps the CLI's default.
    /// Stamped on from the settings as the run starts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(skip)]
    pub auto_compact_window: Option<u32>,
    /// Outcode's own MCP server, added beside the agent's configured ones.
    /// Stamped on by the engine per chat; never on text runs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(skip)]
    pub mcp: Option<McpServer>,
    /// Predict the user's next prompt after each completed turn
    /// ([`AgentEvent::PromptSuggestion`]). Stamped on from the settings as
    /// the run starts.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    #[ts(skip)]
    pub prompt_suggestions: bool,
}

/// A stdio MCP server to launch beside the agent: `command args…` with `env`.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServer {
    pub name: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: std::collections::BTreeMap<String, String>,
}

impl McpServer {
    /// The name Outcode's own server goes by: Claude sees its tools as
    /// `mcp__outcode__<tool>`.
    pub const OUTCODE: &'static str = "outcode";
    /// The chat whose agent launched the server.
    pub const CHAT_ID_ENV: &'static str = "OUTCODE_CHAT_ID";
    /// How long an agent's CLI lets one of its tool calls run: past the
    /// longest an Outcode tool waits on the user (`request_secret`, an hour),
    /// where the CLIs' own defaults cut calls off after a minute or less.
    pub const TOOL_TIMEOUT_SECS: u64 = 65 * 60;

    /// This server, launched for `chat_id`'s agent.
    pub fn for_chat(&self, chat_id: &str) -> Self {
        let mut server = self.clone();
        server.env.insert(Self::CHAT_ID_ENV.into(), chat_id.into());
        server
    }
}

/// How much an agent may do before it has to ask. Whatever the mode doesn't
/// cover reaches the user as an [`InputRequest::Approval`].
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum AccessMode {
    /// Ask before commands and file changes.
    Supervised,
    /// Change files without asking; ask before anything else.
    AutoAcceptEdits,
    /// Run commands and change files without asking.
    #[default]
    FullAccess,
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
    /// A subagent spawn (Claude's `Agent`/`Task`). Its own traffic arrives
    /// as [`AgentEvent::Subagent`] keyed by this call's id.
    Subagent {
        description: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        model: Option<String>,
        /// The task it was given, in full.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        prompt: Option<String>,
        /// Its type (`general-purpose`, `Explore`, a custom agent's name).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        agent: Option<String>,
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

/// What an agent asks of the user mid-turn. The turn waits for the answer,
/// an [`InputResponse`] of the same kind.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
#[ts(optional_fields)]
pub enum InputRequest {
    /// A tool call the access mode doesn't cover: allow it or not.
    Approval {
        /// What is asked about ("Run command", "Edit file").
        title: String,
        /// The call, as the transcript shows it.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        call: Option<ToolCall>,
        /// The tool call's id, when the CLI said.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tool_call_id: Option<String>,
        /// What the agent says the call is for.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
    /// The agent's own questions (Claude's `AskUserQuestion`).
    Questions { questions: Vec<UserInputQuestion> },
    /// Plan mode's plan is ready: start implementing it, or keep planning.
    Plan { plan: String },
}

/// One of an agent's questions.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct UserInputQuestion {
    pub id: String,
    /// A short label for it ("Approach").
    pub header: String,
    pub question: String,
    pub options: Vec<UserInputOption>,
    #[serde(default)]
    pub multi_select: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct UserInputOption {
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// The labels picked for one question; free text counts as a label.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct UserInputAnswer {
    pub question_id: String,
    pub labels: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ApprovalDecision {
    Allow,
    /// Allow this, and calls like it for the rest of the session.
    AllowSession,
    Deny,
}

/// The user's answer to an [`InputRequest`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
#[ts(optional_fields)]
pub enum InputResponse {
    Approval {
        decision: ApprovalDecision,
    },
    Questions {
        answers: Vec<UserInputAnswer>,
    },
    Plan {
        approve: bool,
        /// Kept planning: what to change.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        feedback: Option<String>,
    },
}

/// A command the agent advertises, typed as `/name` at the start of a prompt
/// (a skill also as `$name` anywhere).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct SlashCommand {
    pub name: String,
    #[serde(default)]
    pub description: String,
    /// Placeholder for its argument, when it takes one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_hint: Option<String>,
    #[serde(default)]
    pub kind: CommandKind,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum CommandKind {
    #[default]
    Command,
    Skill,
}

/// Where a context compaction stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum CompactionStatus {
    Running,
    Completed,
    Failed,
    /// The turn ended (stopped) before it finished.
    Stopped,
}

/// Work the agent left running in the background (a subagent, a shell, a
/// monitor). Lives across turns until it ends or is stopped.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct BackgroundTask {
    /// The CLI's task id: what stopping it names.
    pub id: String,
    pub kind: BackgroundTaskKind,
    pub description: String,
    /// The tool call that started it, once known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    /// A subagent's type.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_type: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum BackgroundTaskKind {
    Agent,
    Shell,
    Monitor,
    Other,
}

/// A background task that ended, as the turn it woke names it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct FinishedTask {
    pub description: String,
    pub status: TaskEnd,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum TaskEnd {
    Completed,
    Failed,
    Stopped,
}

/// One step of an agent's turn, normalized across CLIs. A turn ends with
/// [`AgentEvent::Done`]; a failed one reports [`AgentEvent::Error`] first.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
#[ts(optional_fields)]
pub enum AgentEvent {
    /// The CLI's session id, reported as each turn starts; a later run
    /// resumes it ([`RunRequest::resume`]).
    SessionStarted { session_id: String },
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
    /// The turn waits on the user; folded into an `input` part.
    InputRequested { request_id: String, request: InputRequest },
    /// Answered (`response`), or dropped unanswered as the turn ended.
    InputResolved {
        request_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        response: Option<InputResponse>,
    },
    /// How full the context window is. A missing field keeps the last value.
    ContextUsage {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tokens: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        window: Option<u64>,
    },
    /// The turn's billed tokens, as it ends.
    Usage { input_tokens: u64, output_tokens: u64 },
    /// The session's commands and skills, replacing the last list.
    AvailableCommands { commands: Vec<SlashCommand> },
    /// The conversation being summarized to free up context: `/compact`, or
    /// the agent on its own (`auto`). `Running` first, then how it ended.
    Compaction {
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
    /// Every background task the session holds now, replacing the last set.
    /// Session state, not transcript.
    BackgroundTasks { tasks: Vec<BackgroundTask> },
    /// The agent started a turn on its own, between the user's: background
    /// work it waited on ended. Opens a reply with no prompt.
    BackgroundTurn { finished: Vec<FinishedTask> },
    /// A guess at the user's next prompt, after a completed turn (between
    /// turns). Session state, not transcript.
    PromptSuggestion { text: String },
    /// An event of a subagent's own transcript, under the
    /// [`ToolCall::Subagent`] call `parent_tool_id` that spawned it.
    Subagent {
        parent_tool_id: String,
        event: Box<AgentEvent>,
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
