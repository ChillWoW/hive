//! OpenCode 2.x bus frames → [`AgentEvent`]s.
//!
//! Every frame is `{ id, type, data }` with `data.sessionID` naming its
//! session. The run's own session is the root; a subagent runs in a child
//! session, linked to the `subagent` tool call that spawned it (the call's
//! `session.tool.progress` names the child; `session.created` names its
//! parent). A child's events come out wrapped in [`AgentEvent::Subagent`],
//! once per level.
//!
//! Turn ends (`session.execution.*` of the root), permissions and forms are
//! the session loop's; this covers the transcript.

use std::collections::{HashMap, HashSet, VecDeque};

use hive_proto::{AgentEvent, DoneStatus, McpServer, TodoItem, TodoStatus, ToolCall};
use serde_json::Value;

/// Tool output kept on a result; the agent saw all of it.
const OUTPUT_CAP: usize = 16 * 1024;
/// The provider retry that's reported, while opencode keeps trying.
const RETRY_REPORT_ATTEMPT: u64 = 3;

#[derive(Default)]
pub(super) struct Normalizer {
    root: String,
    /// Child session → (parent session, spawning tool call id).
    children: HashMap<String, (String, String)>,
    /// `subagent` calls whose child isn't known yet, by session.
    spawns: VecDeque<(String, String)>,
    /// Tool names from `session.tool.input.started`, by wire call key.
    names: HashMap<String, String>,
    /// Wire call key → the id it was emitted under.
    ids: HashMap<String, String>,
    used_ids: HashSet<String>,
    /// Calls not shown (the `question` tool: its form is the question).
    hidden: HashSet<String>,
    /// Text and reasoning items that streamed deltas, by item key.
    streamed: HashSet<String>,
    /// Each session's model, from its latest step.
    models: HashMap<String, String>,
    windows: HashMap<String, u64>,
    /// The root's tokens this turn: (input, output).
    usage: (u64, u64),
    /// The root wrote text this turn.
    pub text_seen: bool,
    pub last_error: Option<String>,
    /// The model the root session last ran.
    pub model: Option<String>,
}

impl Normalizer {
    pub fn new(root: String, windows: HashMap<String, u64>) -> Self {
        Self {
            root,
            windows,
            ..Self::default()
        }
    }

    pub fn start_turn(&mut self) {
        self.usage = (0, 0);
        self.text_seen = false;
        self.last_error = None;
    }

    /// Whether `session` is the root or one of its descendants.
    pub fn owns(&self, session: &str) -> bool {
        session == self.root || self.children.contains_key(session)
    }

    pub fn frame(&mut self, frame: &Value) -> Vec<AgentEvent> {
        let kind = frame["type"].as_str().unwrap_or_default();
        let data = &frame["data"];
        let Some(session) = data["sessionID"].as_str().filter(|s| !s.is_empty()) else {
            return Vec::new();
        };
        if kind == "session.created" {
            self.bind_created(session, data);
            return Vec::new();
        }
        if !self.owns(session) {
            return Vec::new();
        }
        let root = session == self.root;
        let events = self.events(kind, session, data, root);
        events
            .into_iter()
            .filter_map(|e| self.wrap(session, e))
            .collect()
    }

    fn events(&mut self, kind: &str, session: &str, data: &Value, root: bool) -> Vec<AgentEvent> {
        let message = data["assistantMessageID"].as_str().unwrap_or_default();
        match kind {
            "session.step.started" => {
                if let (Some(provider), Some(id)) =
                    (data["model"]["providerID"].as_str(), data["model"]["id"].as_str())
                {
                    let model = format!("{provider}/{id}");
                    if root {
                        self.model = Some(model.clone());
                    }
                    self.models.insert(session.to_owned(), model);
                }
                Vec::new()
            }
            "session.text.delta" | "session.reasoning.delta" => {
                let text = data["delta"].as_str().unwrap_or_default();
                if text.is_empty() {
                    return Vec::new();
                }
                let reasoning = kind == "session.reasoning.delta";
                self.streamed.insert(item_key(data, reasoning));
                if reasoning {
                    vec![AgentEvent::ReasoningDelta { text: text.into() }]
                } else {
                    if root {
                        self.text_seen = true;
                    }
                    vec![AgentEvent::TextDelta { text: text.into() }]
                }
            }
            // An item that never streamed arrives whole at its end.
            "session.text.ended" | "session.reasoning.ended" => {
                let reasoning = kind == "session.reasoning.ended";
                if self.streamed.remove(&item_key(data, reasoning)) {
                    return Vec::new();
                }
                let text = data["text"].as_str().unwrap_or_default();
                if text.is_empty() {
                    return Vec::new();
                }
                if reasoning {
                    vec![AgentEvent::ReasoningDelta { text: text.into() }]
                } else {
                    if root {
                        self.text_seen = true;
                    }
                    vec![AgentEvent::TextDelta { text: text.into() }]
                }
            }
            "session.tool.input.started" => {
                let key = call_key(session, message, data);
                if let Some(name) = data["name"].as_str() {
                    self.names.insert(key, name.to_owned());
                }
                Vec::new()
            }
            "session.tool.called" => {
                let key = call_key(session, message, data);
                let name = self.names.get(&key).cloned().unwrap_or_default();
                let id = self.emitted_id(&key, data);
                if name == "question" {
                    self.hidden.insert(id);
                    return Vec::new();
                }
                let call = tool_call(&name, &data["input"]);
                if matches!(call, ToolCall::Subagent { .. }) {
                    self.spawns.push_back((session.to_owned(), id.clone()));
                }
                vec![AgentEvent::ToolCall { id, call }]
            }
            "session.tool.progress" => {
                // A subagent's call names its child session.
                let key = call_key(session, message, data);
                if let (Some(child), Some(id)) =
                    (data["metadata"]["sessionID"].as_str(), self.ids.get(&key).cloned())
                {
                    let bound = self.children.get(child).map(|(_, tool)| tool.clone());
                    if child != self.root && bound.as_deref() != Some(id.as_str()) {
                        // Authoritative over the guess `session.created` made:
                        // a call it bound wrongly waits for its own child.
                        self.spawns.retain(|(_, s)| *s != id);
                        if let Some(other) = bound {
                            self.spawns.push_front((session.to_owned(), other));
                        }
                        self.children
                            .insert(child.to_owned(), (session.to_owned(), id));
                    }
                }
                Vec::new()
            }
            "session.tool.success" | "session.tool.failed" | "session.tool.error" => {
                let key = call_key(session, message, data);
                self.names.remove(&key);
                let Some(id) = self.ids.remove(&key) else {
                    return Vec::new();
                };
                if self.hidden.remove(&id) {
                    return Vec::new();
                }
                let is_error = kind != "session.tool.success";
                let output = if is_error {
                    error_message(&data["error"])
                } else {
                    content_text(&data["content"])
                };
                vec![AgentEvent::ToolResult {
                    id,
                    is_error,
                    output: (!output.is_empty()).then(|| cap(&output)),
                    diff: None,
                }]
            }
            "session.step.ended" if root => {
                let tokens = &data["tokens"];
                if !tokens.is_object() {
                    return Vec::new();
                }
                let n = |v: &Value| v.as_u64().unwrap_or(0);
                let input = n(&tokens["input"]) + n(&tokens["cache"]["read"]) + n(&tokens["cache"]["write"]);
                let output = n(&tokens["output"]);
                self.usage.0 += input;
                self.usage.1 += output + n(&tokens["reasoning"]);
                let window = self
                    .models
                    .get(session)
                    .and_then(|m| self.windows.get(m))
                    .copied();
                vec![
                    AgentEvent::ContextUsage {
                        tokens: Some(input + output),
                        window,
                    },
                    AgentEvent::Usage {
                        input_tokens: self.usage.0,
                        output_tokens: self.usage.1,
                    },
                ]
            }
            "session.step.failed" => {
                // An interrupt; the execution's end reports it.
                if data["error"]["type"].as_str() == Some("aborted") {
                    return Vec::new();
                }
                let message = error_message(&data["error"]);
                if root {
                    self.last_error = Some(message.clone());
                }
                vec![AgentEvent::Error { message }]
            }
            "session.retry.scheduled" => {
                let attempt = data["attempt"].as_u64().unwrap_or(0);
                if attempt != RETRY_REPORT_ATTEMPT {
                    return Vec::new();
                }
                let reason = error_message(&data["error"]);
                vec![AgentEvent::Error {
                    message: format!("The model provider keeps failing; OpenCode is retrying ({reason})."),
                }]
            }
            // A subagent's end; the root's is the session loop's.
            "session.execution.succeeded" | "session.execution.interrupted"
            | "session.execution.failed"
                if !root =>
            {
                let (status, error) = match kind {
                    "session.execution.succeeded" => (DoneStatus::Completed, None),
                    "session.execution.interrupted" => (DoneStatus::Interrupted, None),
                    _ => (DoneStatus::Errored, Some(error_message(&data["error"]))),
                };
                vec![AgentEvent::Done {
                    status,
                    error,
                    session_id: Some(session.to_owned()),
                }]
            }
            "session.execution.failed" => {
                self.last_error = Some(error_message(&data["error"]));
                Vec::new()
            }
            _ => Vec::new(),
        }
    }

    /// A child session created under one of ours: bound to that session's
    /// oldest unbound `subagent` call, unless its progress bound it already.
    fn bind_created(&mut self, session: &str, data: &Value) {
        let Some(parent) = data["parentID"].as_str() else {
            return;
        };
        if !self.owns(parent) || self.owns(session) {
            return;
        }
        if let Some(at) = self.spawns.iter().position(|(s, _)| s == parent) {
            let (_, tool) = self.spawns.remove(at).unwrap_or_default();
            self.children
                .insert(session.to_owned(), (parent.to_owned(), tool));
        }
    }

    /// The id a wire call is shown under: its own, unless taken (providers
    /// may reuse ids across messages).
    fn emitted_id(&mut self, key: &str, data: &Value) -> String {
        if let Some(id) = self.ids.get(key) {
            return id.clone();
        }
        let call = data["id"].as_str().unwrap_or_default();
        let id = if !call.is_empty() && !self.used_ids.contains(call) {
            call.to_owned()
        } else {
            key.to_owned()
        };
        self.used_ids.insert(id.clone());
        self.ids.insert(key.to_owned(), id.clone());
        id
    }

    /// `event` from `session` as the root's transcript carries it.
    fn wrap(&self, session: &str, mut event: AgentEvent) -> Option<AgentEvent> {
        let mut current = session;
        let mut depth = 0;
        while current != self.root {
            let (parent, tool) = self.children.get(current)?;
            event = AgentEvent::Subagent {
                parent_tool_id: tool.clone(),
                event: Box::new(event),
            };
            current = parent;
            depth += 1;
            if depth > 32 {
                return None;
            }
        }
        Some(event)
    }
}

fn call_key(session: &str, message: &str, data: &Value) -> String {
    format!(
        "{session}:{message}:{}",
        data["id"].as_str().unwrap_or_default()
    )
}

fn item_key(data: &Value, reasoning: bool) -> String {
    format!(
        "{}:{}:{}{}",
        data["sessionID"].as_str().unwrap_or_default(),
        data["assistantMessageID"].as_str().unwrap_or_default(),
        if reasoning { 'r' } else { 't' },
        data["ordinal"].as_u64().unwrap_or(0)
    )
}

/// `{ type, message }`; the message may be empty (`provider.auth`).
pub(super) fn error_message(error: &Value) -> String {
    if let Some(text) = error.as_str() {
        return text.to_owned();
    }
    match error["message"].as_str().filter(|m| !m.trim().is_empty()) {
        Some(message) => message.to_owned(),
        None => match error["type"].as_str() {
            Some(kind) => format!("OpenCode failed ({kind})."),
            None => "OpenCode failed.".into(),
        },
    }
}

fn content_text(content: &Value) -> String {
    content
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|part| part["text"].as_str())
        .collect::<Vec<_>>()
        .join("\n")
}

fn cap(text: &str) -> String {
    if text.len() <= OUTPUT_CAP {
        return text.to_owned();
    }
    let mut end = OUTPUT_CAP;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &text[..end])
}

/// An OpenCode tool invocation, typed. 2.x names its shell tool `shell`
/// and its spawn tool `subagent`; the 1.x names are kept.
pub(super) fn tool_call(name: &str, input: &Value) -> ToolCall {
    let s = |keys: &[&str]| {
        keys.iter()
            .find_map(|k| input[*k].as_str())
            .filter(|v| !v.is_empty())
            .map(str::to_owned)
    };
    let path = || s(&["path", "filePath", "file_path"]).unwrap_or_default();
    match name {
        "shell" | "bash" => ToolCall::Exec {
            command: s(&["command"]).unwrap_or_default(),
        },
        "read" => ToolCall::ReadFile { path: path() },
        "write" => ToolCall::WriteFile {
            path: path(),
            content: s(&["content"]),
        },
        "edit" | "multiedit" => ToolCall::EditFile {
            path: path(),
            old_string: s(&["oldString", "old_string"]),
            new_string: s(&["newString", "new_string"]),
        },
        "patch" | "apply_patch" => ToolCall::ApplyPatch {
            path: s(&["path", "filePath", "file_path"]),
        },
        "grep" => ToolCall::Search {
            pattern: s(&["pattern"]).unwrap_or_default(),
            path: s(&["path", "include"]),
        },
        "glob" => ToolCall::Glob {
            pattern: s(&["pattern"]).unwrap_or_default(),
        },
        "webfetch" => ToolCall::WebFetch {
            url: s(&["url"]).unwrap_or_default(),
            prompt: None,
        },
        "websearch" => ToolCall::WebSearch {
            query: s(&["query"]).unwrap_or_default(),
        },
        "todowrite" => ToolCall::Todo {
            items: input["todos"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|t| TodoItem {
                    text: t["content"].as_str().unwrap_or_default().to_owned(),
                    status: TodoStatus::parse(t["status"].as_str().unwrap_or_default()),
                })
                .collect(),
        },
        "subagent" | "task" => ToolCall::Subagent {
            description: s(&["description"])
                .or_else(|| s(&["prompt"]).and_then(|p| p.lines().next().map(str::to_owned)))
                .unwrap_or_else(|| "Subagent".into()),
            model: None,
        },
        // MCP tools arrive as `<server>_<tool>`; only Hive's own server is
        // known, the rest can't be told from built-in tools.
        _ => match name
            .strip_prefix(McpServer::HIVE)
            .and_then(|rest| rest.strip_prefix('_'))
        {
            Some(tool) if !tool.is_empty() => ToolCall::Mcp {
                server: McpServer::HIVE.into(),
                tool: tool.to_owned(),
                input: (!input.is_null()).then(|| input.clone()),
            },
            _ => ToolCall::Unknown {
                name: name.to_owned(),
                input: (!input.is_null()).then(|| input.clone()),
            },
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn hive_tools_are_mcp_calls() {
        assert_eq!(
            tool_call("hive_whoami", &json!({})),
            ToolCall::Mcp {
                server: "hive".into(),
                tool: "whoami".into(),
                input: Some(json!({})),
            }
        );
        assert!(matches!(tool_call("hive_", &Value::Null), ToolCall::Unknown { .. }));
        assert!(matches!(tool_call("hivemind", &Value::Null), ToolCall::Unknown { .. }));
    }

    fn frame(kind: &str, data: Value) -> Value {
        json!({ "id": "evt", "type": kind, "data": data })
    }

    fn run(n: &mut Normalizer, frames: &[Value]) -> Vec<AgentEvent> {
        frames.iter().flat_map(|f| n.frame(f)).collect()
    }

    #[test]
    fn a_turn_streams_text_tools_and_usage() {
        let mut windows = HashMap::new();
        windows.insert("openrouter/p".to_owned(), 1000);
        let mut n = Normalizer::new("S".into(), windows);
        let base = json!({ "sessionID": "S", "assistantMessageID": "M" });
        let with = |extra: Value| {
            let mut v = base.clone();
            v.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
            v
        };
        let events = run(
            &mut n,
            &[
                frame("session.step.started", with(json!({ "model": { "id": "p", "providerID": "openrouter" } }))),
                frame("session.text.delta", with(json!({ "ordinal": 0, "delta": "Hi" }))),
                frame("session.text.ended", with(json!({ "ordinal": 0, "text": "Hi" }))),
                frame("session.reasoning.ended", with(json!({ "ordinal": 0, "text": "hmm" }))),
                frame("session.tool.input.started", with(json!({ "id": "c1", "name": "shell" }))),
                frame("session.tool.called", with(json!({ "id": "c1", "input": { "command": "echo hi" } }))),
                frame("session.tool.success", with(json!({ "id": "c1", "content": [{ "type": "text", "text": "hi\n" }] }))),
                frame("session.step.ended", with(json!({ "tokens": { "input": 10, "output": 2, "reasoning": 1, "cache": { "read": 5, "write": 0 } } }))),
                frame("other.session", json!({ "sessionID": "X" })),
            ],
        );
        assert_eq!(
            events,
            vec![
                AgentEvent::TextDelta { text: "Hi".into() },
                AgentEvent::ReasoningDelta { text: "hmm".into() },
                AgentEvent::ToolCall { id: "c1".into(), call: ToolCall::Exec { command: "echo hi".into() } },
                AgentEvent::ToolResult { id: "c1".into(), is_error: false, output: Some("hi\n".into()), diff: None },
                AgentEvent::ContextUsage { tokens: Some(17), window: Some(1000) },
                AgentEvent::Usage { input_tokens: 15, output_tokens: 3 },
            ]
        );
        assert!(n.text_seen);
        assert_eq!(n.model.as_deref(), Some("openrouter/p"));
    }

    #[test]
    fn subagent_sessions_are_wrapped() {
        let mut n = Normalizer::new("S".into(), HashMap::new());
        let events = run(
            &mut n,
            &[
                frame("session.tool.input.started", json!({ "sessionID": "S", "assistantMessageID": "M", "id": "t", "name": "subagent" })),
                frame("session.tool.called", json!({ "sessionID": "S", "assistantMessageID": "M", "id": "t", "input": { "agent": "general", "description": "Look", "prompt": "…" } })),
                frame("session.created", json!({ "sessionID": "C", "parentID": "S" })),
                frame("session.tool.progress", json!({ "sessionID": "S", "assistantMessageID": "M", "id": "t", "metadata": { "sessionID": "C" } })),
                frame("session.text.delta", json!({ "sessionID": "C", "assistantMessageID": "N", "ordinal": 0, "delta": "found" })),
                frame("session.execution.succeeded", json!({ "sessionID": "C" })),
            ],
        );
        assert!(matches!(&events[0], AgentEvent::ToolCall { call: ToolCall::Subagent { description, .. }, .. } if description == "Look"));
        assert_eq!(
            events[1],
            AgentEvent::Subagent { parent_tool_id: "t".into(), event: Box::new(AgentEvent::TextDelta { text: "found".into() }) }
        );
        assert!(matches!(&events[2], AgentEvent::Subagent { event, .. } if matches!(**event, AgentEvent::Done { status: DoneStatus::Completed, .. })));
        assert!(n.owns("C") && !n.owns("X"));
    }

    #[test]
    fn question_calls_are_hidden_and_failures_reported() {
        let mut n = Normalizer::new("S".into(), HashMap::new());
        let d = |extra: Value| {
            let mut v = json!({ "sessionID": "S", "assistantMessageID": "M" });
            v.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
            v
        };
        let events = run(
            &mut n,
            &[
                frame("session.tool.input.started", d(json!({ "id": "q", "name": "question" }))),
                frame("session.tool.called", d(json!({ "id": "q", "input": {} }))),
                frame("session.tool.success", d(json!({ "id": "q", "content": [] }))),
                frame("session.tool.input.started", d(json!({ "id": "e", "name": "edit" }))),
                frame("session.tool.called", d(json!({ "id": "e", "input": { "path": "a", "oldString": "x", "newString": "y" } }))),
                frame("session.tool.failed", d(json!({ "id": "e", "error": { "type": "aborted", "message": "Tool execution interrupted" } }))),
                frame("session.step.failed", d(json!({ "error": { "type": "aborted" } }))),
                frame("session.step.failed", d(json!({ "error": { "type": "provider.auth", "message": "" } }))),
            ],
        );
        assert_eq!(events.len(), 3);
        assert!(matches!(&events[1], AgentEvent::ToolResult { is_error: true, output: Some(o), .. } if o == "Tool execution interrupted"));
        assert_eq!(events[2], AgentEvent::Error { message: "OpenCode failed (provider.auth).".into() });
    }
}
