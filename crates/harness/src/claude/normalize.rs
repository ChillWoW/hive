//! Claude stdout frames → [`AgentEvent`]s.

use std::collections::HashSet;

use hive_proto::{AgentEvent, DoneStatus, HarnessId, TodoItem, TodoStatus, ToolCall};
use serde_json::Value;

use super::wire::{ContentBlock, Frame};

/// Per-session normalization state.
#[derive(Default)]
pub(crate) struct Normalizer {
    /// The CLI re-emits `system:init` whenever it re-invokes the model in
    /// one session (every turn, background wake-ups); only the first one is
    /// a session start.
    saw_init: bool,
    last_model: Option<String>,
    /// Ids of `Agent`/`Task` spawn calls. `task_notification` settles
    /// background shells through the same subtype, so only these may be
    /// settled as subagents.
    spawns: HashSet<String>,
    pub session_id: Option<String>,
}

impl Normalizer {
    /// `interrupted` turns the turn's `result` into an interrupted `Done`.
    pub fn normalize(&mut self, frame: Frame, interrupted: bool) -> Vec<AgentEvent> {
        match frame {
            Frame::System(f) => match f.subtype.as_str() {
                "init" if !self.saw_init => {
                    self.saw_init = true;
                    self.session_id = Some(f.session_id.clone());
                    vec![AgentEvent::SessionStarted {
                        harness: HarnessId::ClaudeCode,
                        model: f.model,
                        cwd: f.cwd,
                        session_id: f.session_id,
                        tools: f.tools,
                    }]
                }
                // A background subagent's only terminal signal: the stream
                // just stops, then this arrives untagged.
                "task_notification" => {
                    let Some(parent) = f.tool_use_id.filter(|id| self.spawns.contains(id)) else {
                        return Vec::new();
                    };
                    let status = match f.status.as_deref().unwrap_or("") {
                        "completed" | "complete" | "succeeded" | "success" => DoneStatus::Completed,
                        "failed" | "errored" | "error" => DoneStatus::Errored,
                        "killed" | "cancelled" | "canceled" | "stopped" | "interrupted" => {
                            DoneStatus::Interrupted
                        }
                        _ => return Vec::new(),
                    };
                    vec![tag(
                        &parent,
                        AgentEvent::Done {
                            status,
                            error: None,
                            session_id: None,
                        },
                    )]
                }
                _ => Vec::new(),
            },

            Frame::StreamEvent(f) => {
                if f.event.kind != "content_block_delta" {
                    return Vec::new();
                }
                let delta = f.event.delta;
                let event = match delta.kind.as_str() {
                    "text_delta" if !delta.text.is_empty() => {
                        AgentEvent::TextDelta { text: delta.text }
                    }
                    "thinking_delta" if !delta.thinking.is_empty() => AgentEvent::ReasoningDelta {
                        text: delta.thinking,
                    },
                    _ => return Vec::new(),
                };
                vec![attribute(f.parent_tool_use_id.as_deref(), event)]
            }

            Frame::Assistant(f) => {
                let parent = f.parent_tool_use_id.as_deref();
                let mut out = Vec::new();
                for block in f.message.blocks() {
                    match block.kind.as_str() {
                        "tool_use" => {
                            if is_spawn(&block.name) {
                                self.spawns.insert(block.id.clone());
                            }
                            out.push(attribute(
                                parent,
                                AgentEvent::ToolCall {
                                    call: decode_tool_use(&block.name, &block.input),
                                    id: block.id,
                                },
                            ));
                        }
                        // Top-level text already streamed as deltas; a
                        // subagent's arrives only as whole blocks.
                        "text" if parent.is_some() && !block.text.is_empty() => {
                            out.push(attribute(
                                parent,
                                AgentEvent::TextDelta {
                                    text: format!("{}\n\n", block.text.trim_end()),
                                },
                            ));
                        }
                        _ => {}
                    }
                }
                if let Some(code) = &f.error {
                    out.push(attribute(
                        parent,
                        AgentEvent::Error {
                            message: assistant_error_text(code),
                        },
                    ));
                }
                if parent.is_none() {
                    self.last_model = f.message.model.or(self.last_model.take());
                    if let Some(tokens) = f.message.usage.as_ref().and_then(context_tokens) {
                        out.push(AgentEvent::ContextUsage {
                            tokens: Some(tokens),
                            window: None,
                        });
                    }
                }
                out
            }

            // Top-level user frames carry tool results (our own prompts are
            // not echoed without `--replay-user-messages`).
            Frame::User(f) => {
                let parent = f.parent_tool_use_id.as_deref();
                f.message
                    .blocks()
                    .filter(|b: &ContentBlock| b.kind == "tool_result")
                    .map(|b| {
                        attribute(
                            parent,
                            AgentEvent::ToolResult {
                                output: b.result_text(),
                                is_error: b.is_error.unwrap_or(false),
                                id: b.tool_use_id,
                                diff: None,
                            },
                        )
                    })
                    .collect()
            }

            Frame::RateLimit(f) if f.rate_limit_info.blocks() => {
                let window =
                    rate_window_label(f.rate_limit_info.rate_limit_type.as_deref().unwrap_or(""));
                vec![AgentEvent::Error {
                    message: format!(
                        "Claude {window} limit reached; the turn was blocked. Try again after it resets."
                    ),
                }]
            }

            Frame::Result(f) => {
                if let Some(id) = &f.session_id {
                    self.session_id = Some(id.clone());
                }
                let mut out = Vec::new();
                if let Some(window) = self.context_window(&f.model_usage) {
                    out.push(AgentEvent::ContextUsage {
                        tokens: None,
                        window: Some(window),
                    });
                }
                out.push(AgentEvent::Usage {
                    input_tokens: f.usage.input_tokens,
                    output_tokens: f.usage.output_tokens,
                });
                let (status, error) = if interrupted {
                    // An interrupted turn ends as an error subtype whose
                    // errors are CLI-internal diagnostics.
                    (DoneStatus::Interrupted, None)
                } else if f.subtype == "success" {
                    (DoneStatus::Completed, None)
                } else {
                    (
                        DoneStatus::Errored,
                        Some(result_error(&f.subtype, &f.errors)),
                    )
                };
                out.push(AgentEvent::Done {
                    status,
                    error,
                    session_id: f.session_id,
                });
                out
            }

            Frame::RateLimit(_)
            | Frame::ControlRequest(_)
            | Frame::ControlResponse(_)
            | Frame::Other => Vec::new(),
        }
    }

    /// The context window of the model the turn ran on, from the result's
    /// per-model usage.
    fn context_window(
        &self,
        model_usage: &std::collections::BTreeMap<String, Value>,
    ) -> Option<u64> {
        let entry = self
            .last_model
            .as_ref()
            .and_then(|model| model_usage.get(model))
            .or_else(|| {
                (model_usage.len() == 1)
                    .then(|| model_usage.values().next())
                    .flatten()
            })?;
        entry
            .get("contextWindow")
            .and_then(Value::as_u64)
            .filter(|n| *n > 0)
    }
}

/// Subagent traffic arrives on the same stdout, tagged with the spawn call's
/// id; it never folds into the parent transcript.
fn attribute(parent: Option<&str>, event: AgentEvent) -> AgentEvent {
    match parent {
        Some(parent) => tag(parent, event),
        None => event,
    }
}

fn tag(parent: &str, event: AgentEvent) -> AgentEvent {
    AgentEvent::Subagent {
        parent_tool_id: parent.to_owned(),
        event: Box::new(event),
    }
}

fn is_spawn(tool: &str) -> bool {
    matches!(tool, "Agent" | "Task")
}

/// Everything in the prompt: fresh input plus cache reads and writes.
fn context_tokens(usage: &Value) -> Option<u64> {
    let fields = [
        "input_tokens",
        "cache_read_input_tokens",
        "cache_creation_input_tokens",
    ];
    let counts: Vec<u64> = fields
        .iter()
        .filter_map(|key| usage.get(*key).and_then(Value::as_u64))
        .collect();
    (!counts.is_empty()).then(|| counts.iter().sum())
}

fn str_field(input: &Value, key: &str) -> String {
    opt_str_field(input, key).unwrap_or_default()
}

fn opt_str_field(input: &Value, key: &str) -> Option<String> {
    input.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn raw_input(input: &Value) -> Option<Value> {
    (!input.is_null()).then(|| input.clone())
}

/// Claude's tool names and inputs → typed [`ToolCall`]s.
pub(crate) fn decode_tool_use(name: &str, input: &Value) -> ToolCall {
    match name {
        // On Windows the CLI offers `PowerShell` beside (or instead of) `Bash`.
        "Bash" | "PowerShell" => ToolCall::Exec {
            command: str_field(input, "command"),
        },
        "Read" => ToolCall::ReadFile {
            path: str_field(input, "file_path"),
        },
        "Write" => ToolCall::WriteFile {
            path: str_field(input, "file_path"),
            content: opt_str_field(input, "content"),
        },
        "Edit" => ToolCall::EditFile {
            path: str_field(input, "file_path"),
            old_string: opt_str_field(input, "old_string"),
            new_string: opt_str_field(input, "new_string"),
        },
        "Grep" => ToolCall::Search {
            pattern: str_field(input, "pattern"),
            path: opt_str_field(input, "path"),
        },
        "Glob" => ToolCall::Glob {
            pattern: str_field(input, "pattern"),
        },
        "WebFetch" => ToolCall::WebFetch {
            url: str_field(input, "url"),
            prompt: opt_str_field(input, "prompt"),
        },
        "WebSearch" => ToolCall::WebSearch {
            query: str_field(input, "query"),
        },
        "TodoWrite" => ToolCall::Todo {
            items: input
                .get("todos")
                .and_then(Value::as_array)
                .map(Vec::as_slice)
                .unwrap_or_default()
                .iter()
                .map(|t| TodoItem {
                    text: str_field(t, "content"),
                    status: TodoStatus::parse(
                        t.get("status").and_then(Value::as_str).unwrap_or(""),
                    ),
                })
                .collect(),
        },
        _ if is_spawn(name) => ToolCall::Subagent {
            description: str_field(input, "description"),
            model: opt_str_field(input, "model"),
        },
        // MCP tools arrive as `mcp__<server>__<tool>`.
        _ => match name
            .strip_prefix("mcp__")
            .and_then(|rest| rest.split_once("__"))
        {
            Some((server, tool)) => ToolCall::Mcp {
                server: server.into(),
                tool: tool.into(),
                input: raw_input(input),
            },
            None => ToolCall::Unknown {
                name: name.into(),
                input: raw_input(input),
            },
        },
    }
}

/// The CLI reports a failed turn (usage limit, auth, …) as a terse code on
/// an `assistant` frame, often with no text and no `result` error.
fn assistant_error_text(code: &str) -> String {
    match code {
        "authentication_failed" => "Authentication failed; sign in to Claude again.".into(),
        "billing_error" => "Billing error; check your Claude plan or payment method.".into(),
        "rate_limit" => "Claude usage limit reached; try again after it resets.".into(),
        "overloaded" => "Claude is overloaded right now; try again shortly.".into(),
        "invalid_request" => "The request was rejected as invalid.".into(),
        "model_not_found" => "The selected model isn't available.".into(),
        "server_error" => "Claude had a server error; try again.".into(),
        "max_output_tokens" => "The reply hit the maximum output length.".into(),
        other => format!("Claude error: {other}"),
    }
}

fn rate_window_label(kind: &str) -> &'static str {
    match kind {
        "five_hour" => "5-hour",
        "seven_day" | "seven_day_overage_included" => "weekly",
        "seven_day_opus" => "weekly (Opus)",
        "seven_day_sonnet" => "weekly (Sonnet)",
        _ => "usage",
    }
}

/// A failed `result`'s error, never blank. The CLI mixes internal
/// `[ede_diagnostic]` breadcrumbs into `errors`; those are dropped.
fn result_error(subtype: &str, errors: &[Value]) -> String {
    let real: Vec<String> = errors
        .iter()
        .map(|e| match e {
            Value::String(s) => s.clone(),
            other => other.to_string(),
        })
        .filter(|m| !m.contains("[ede_diagnostic]"))
        .collect();
    if !real.is_empty() {
        return real.join("; ");
    }
    match subtype {
        "error_max_turns" => "The run hit the maximum number of turns.",
        "error_max_budget_usd" => "The run hit its cost budget.",
        _ => "The run ended with an error.",
    }
    .into()
}

#[cfg(test)]
mod tests {
    use super::super::wire::parse_frame;
    use super::*;
    use serde_json::json;

    fn normalize(n: &mut Normalizer, raw: Value) -> Vec<AgentEvent> {
        n.normalize(parse_frame(&raw.to_string()).unwrap(), false)
    }

    #[test]
    fn init_starts_the_session_once() {
        let mut n = Normalizer::default();
        let init = json!({"type":"system","subtype":"init","model":"opus","cwd":"/x","session_id":"s1","tools":["Bash"]});
        assert!(matches!(
            normalize(&mut n, init.clone()).as_slice(),
            [AgentEvent::SessionStarted { session_id, .. }] if session_id == "s1"
        ));
        assert!(normalize(&mut n, init).is_empty());
    }

    #[test]
    fn deltas_become_text_and_reasoning() {
        let mut n = Normalizer::default();
        let delta = |kind: &str, key: &str| json!({"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":kind, key:"hi"}}});
        assert_eq!(
            normalize(&mut n, delta("text_delta", "text")),
            vec![AgentEvent::TextDelta { text: "hi".into() }]
        );
        assert_eq!(
            normalize(&mut n, delta("thinking_delta", "thinking")),
            vec![AgentEvent::ReasoningDelta { text: "hi".into() }]
        );
    }

    #[test]
    fn tool_use_and_result_round_trip() {
        let mut n = Normalizer::default();
        let call = normalize(
            &mut n,
            json!({"type":"assistant","message":{"content":[
                {"type":"text","text":"already streamed"},
                {"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls"}}
            ]}}),
        );
        assert_eq!(
            call,
            vec![AgentEvent::ToolCall {
                id: "t1".into(),
                call: ToolCall::Exec {
                    command: "ls".into()
                }
            }]
        );
        let result = normalize(
            &mut n,
            json!({"type":"user","message":{"content":[
                {"type":"tool_result","tool_use_id":"t1","content":"a.txt","is_error":false}
            ]}}),
        );
        assert_eq!(
            result,
            vec![AgentEvent::ToolResult {
                id: "t1".into(),
                is_error: false,
                output: Some("a.txt".into()),
                diff: None
            }]
        );
    }

    #[test]
    fn subagent_traffic_is_tagged_and_settled_by_its_notification() {
        let mut n = Normalizer::default();
        normalize(
            &mut n,
            json!({"type":"assistant","message":{"content":[
                {"type":"tool_use","id":"spawn","name":"Agent","input":{"description":"scan","prompt":"p"}}
            ]}}),
        );
        let inner = normalize(
            &mut n,
            json!({"type":"assistant","parent_tool_use_id":"spawn","message":{"content":[
                {"type":"text","text":"looking"}
            ]}}),
        );
        assert!(matches!(
            inner.as_slice(),
            [AgentEvent::Subagent { parent_tool_id, event }]
                if parent_tool_id == "spawn" && matches!(**event, AgentEvent::TextDelta { .. })
        ));
        let done = normalize(
            &mut n,
            json!({"type":"system","subtype":"task_notification","tool_use_id":"spawn","status":"completed"}),
        );
        assert!(matches!(
            done.as_slice(),
            [AgentEvent::Subagent { event, .. }]
                if matches!(**event, AgentEvent::Done { status: DoneStatus::Completed, .. })
        ));
        // A background shell settling through the same subtype is ignored.
        assert!(normalize(
            &mut n,
            json!({"type":"system","subtype":"task_notification","tool_use_id":"bash1","status":"completed"}),
        )
        .is_empty());
    }

    #[test]
    fn result_ends_the_turn() {
        let mut n = Normalizer::default();
        let out = normalize(
            &mut n,
            json!({"type":"result","subtype":"error_during_execution","errors":["[ede_diagnostic] x"],"usage":{"input_tokens":3,"output_tokens":4},"session_id":"s1"}),
        );
        assert!(matches!(
            out.last(),
            Some(AgentEvent::Done { status: DoneStatus::Errored, error: Some(e), .. })
                if e == "The run ended with an error."
        ));
        let interrupted = n.normalize(
            parse_frame(r#"{"type":"result","subtype":"error_during_execution"}"#).unwrap(),
            true,
        );
        assert!(matches!(
            interrupted.last(),
            Some(AgentEvent::Done {
                status: DoneStatus::Interrupted,
                error: None,
                ..
            })
        ));
    }

    #[test]
    fn decodes_spawns_and_mcp_tools() {
        assert_eq!(
            decode_tool_use("Task", &json!({"description":"scan","model":"haiku"})),
            ToolCall::Subagent {
                description: "scan".into(),
                model: Some("haiku".into())
            }
        );
        assert!(matches!(
            decode_tool_use("mcp__github__get_me", &json!({})),
            ToolCall::Mcp { server, tool, .. } if server == "github" && tool == "get_me"
        ));
    }
}
