//! Claude stdout frames → [`AgentEvent`]s, one turn at a time.

use outcode_proto::{AgentEvent, TodoItem, TodoStatus, ToolCall};
use serde_json::Value;

/// A `result` frame: the turn is over.
#[derive(Debug, PartialEq)]
pub(super) struct TurnEnd {
    /// Why it failed, when it did.
    pub error: Option<String>,
}

/// One turn's normalization state; replaced when the turn ends.
#[derive(Default)]
pub(super) struct Normalizer {
    /// The last event was text: another text block starts a new paragraph.
    after_text: bool,
    /// Text streamed this turn: the `result`'s text isn't a reply to show.
    spoke: bool,
}

impl Normalizer {
    /// The events `frame` makes, and the turn's end when it's the `result`.
    /// Subagents' traffic (tagged with the spawning call's id) is skipped.
    pub fn frame(&mut self, frame: &Value) -> (Vec<AgentEvent>, Option<TurnEnd>) {
        if frame["parent_tool_use_id"].is_string() {
            return (Vec::new(), None);
        }
        let events = match frame["type"].as_str() {
            Some("system") if frame["subtype"] == "init" => frame["session_id"]
                .as_str()
                .map(|id| AgentEvent::SessionStarted { session_id: id.into() })
                .into_iter()
                .collect(),
            Some("stream_event") => self.stream_event(&frame["event"]),
            Some("assistant") => assistant(frame),
            Some("user") => tool_results(frame),
            Some("result") => return self.result(frame),
            _ => Vec::new(),
        };
        if let Some(last) = events.last() {
            self.after_text = matches!(last, AgentEvent::TextDelta { .. });
        }
        (events, None)
    }

    fn stream_event(&mut self, event: &Value) -> Vec<AgentEvent> {
        match event["type"].as_str() {
            Some("content_block_start")
                if event["content_block"]["type"] == "text" && self.after_text =>
            {
                vec![text("\n\n")]
            }
            Some("content_block_delta") => {
                let delta = &event["delta"];
                let field = |key: &str| delta[key].as_str().filter(|s| !s.is_empty());
                match delta["type"].as_str() {
                    Some("text_delta") => field("text").map_or_else(Vec::new, |t| {
                        self.spoke = true;
                        vec![text(t)]
                    }),
                    Some("thinking_delta") => field("thinking").map_or_else(Vec::new, |t| {
                        vec![AgentEvent::ReasoningDelta { text: t.into() }]
                    }),
                    _ => Vec::new(),
                }
            }
            _ => Vec::new(),
        }
    }

    fn result(&mut self, frame: &Value) -> (Vec<AgentEvent>, Option<TurnEnd>) {
        let failed = frame["is_error"].as_bool().unwrap_or(false)
            || frame["subtype"].as_str().is_some_and(|s| s != "success");
        if failed {
            return (Vec::new(), Some(TurnEnd { error: Some(result_error(frame)) }));
        }
        // A local command (`/context`, `/cost`, …) answers only here; a
        // model turn's text already streamed.
        let reply = frame["result"].as_str().map(str::trim).filter(|t| !t.is_empty());
        let events = match reply {
            Some(reply) if !self.spoke => vec![text(reply)],
            _ => Vec::new(),
        };
        (events, Some(TurnEnd { error: None }))
    }
}

fn text(text: &str) -> AgentEvent {
    AgentEvent::TextDelta { text: text.into() }
}

/// An `assistant` frame's content blocks as a list.
fn blocks(frame: &Value) -> &[Value] {
    frame["message"]["content"].as_array().map_or(&[], Vec::as_slice)
}

/// Tool calls (text and thinking already streamed as deltas), and the
/// terse error code the CLI reports a failed request with.
fn assistant(frame: &Value) -> Vec<AgentEvent> {
    let mut out: Vec<AgentEvent> = blocks(frame)
        .iter()
        .filter(|b| b["type"] == "tool_use")
        .map(|b| AgentEvent::ToolCall {
            id: b["id"].as_str().unwrap_or_default().into(),
            call: decode_tool_use(b["name"].as_str().unwrap_or_default(), &b["input"]),
        })
        .collect();
    if let Some(code) = frame["error"].as_str() {
        out.push(AgentEvent::Error {
            message: assistant_error_text(code),
        });
    }
    out
}

/// A `user` frame's tool results (our own prompts aren't echoed).
fn tool_results(frame: &Value) -> Vec<AgentEvent> {
    blocks(frame)
        .iter()
        .filter(|b| b["type"] == "tool_result")
        .map(|b| AgentEvent::ToolResult {
            id: b["tool_use_id"].as_str().unwrap_or_default().into(),
            is_error: b["is_error"].as_bool().unwrap_or(false),
            output: result_text(&b["content"]),
        })
        .collect()
}

/// A `tool_result`'s output: a string or an array of text blocks.
fn result_text(content: &Value) -> Option<String> {
    let text = match content {
        Value::String(s) => s.clone(),
        Value::Array(blocks) => blocks
            .iter()
            .filter_map(|b| b["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n"),
        _ => return None,
    };
    (!text.is_empty()).then_some(text)
}

fn str_field(input: &Value, key: &str) -> String {
    opt_str_field(input, key).unwrap_or_default()
}

fn opt_str_field(input: &Value, key: &str) -> Option<String> {
    input[key].as_str().map(str::to_owned)
}

fn raw_input(input: &Value) -> Option<Value> {
    (!input.is_null()).then(|| input.clone())
}

/// Claude's tool names and inputs → typed [`ToolCall`]s.
fn decode_tool_use(name: &str, input: &Value) -> ToolCall {
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
            items: input["todos"]
                .as_array()
                .map_or(&[][..], Vec::as_slice)
                .iter()
                .map(|t| TodoItem {
                    text: str_field(t, "content"),
                    status: TodoStatus::parse(t["status"].as_str().unwrap_or("")),
                })
                .collect(),
        },
        // MCP tools arrive as `mcp__<server>__<tool>`.
        _ => match name.strip_prefix("mcp__").and_then(|rest| rest.split_once("__")) {
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

/// The CLI reports a failed request (usage limit, auth, …) as a terse code
/// on an `assistant` frame.
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

/// What a failed `result` says went wrong, never blank. The CLI mixes
/// internal `[ede_diagnostic]` breadcrumbs into `errors`; those are dropped.
fn result_error(frame: &Value) -> String {
    if let Some(result) = frame["result"].as_str().filter(|r| !r.trim().is_empty()) {
        return result.trim().to_owned();
    }
    let errors: Vec<String> = frame["errors"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|e| e.as_str().map_or_else(|| e.to_string(), str::to_owned))
        .filter(|m| !m.contains("[ede_diagnostic]"))
        .collect();
    if !errors.is_empty() {
        return errors.join("\n");
    }
    match frame["subtype"].as_str() {
        Some("error_max_turns") => "The run hit the maximum number of turns.".into(),
        Some("error_max_budget_usd") => "The run hit its cost budget.".into(),
        _ => "Claude's turn failed.".into(),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn feed(frames: &[Value]) -> (Vec<AgentEvent>, Option<TurnEnd>) {
        let mut normalizer = Normalizer::default();
        let mut events = Vec::new();
        for frame in frames {
            let (out, end) = normalizer.frame(frame);
            events.extend(out);
            if end.is_some() {
                return (events, end);
            }
        }
        (events, None)
    }

    fn delta(kind: &str, field: &str, text: &str) -> Value {
        json!({
            "type": "stream_event",
            "parent_tool_use_id": null,
            "event": { "type": "content_block_delta", "index": 0,
                       "delta": { "type": kind, field: text } },
        })
    }

    fn text_delta(t: &str) -> Value {
        delta("text_delta", "text", t)
    }

    fn block_start(kind: &str) -> Value {
        json!({
            "type": "stream_event",
            "event": { "type": "content_block_start", "content_block": { "type": kind } },
        })
    }

    fn success(result: &str) -> Value {
        json!({ "type": "result", "subtype": "success", "is_error": false, "result": result })
    }

    #[test]
    fn init_reports_the_session() {
        let (events, _) = feed(&[json!({ "type": "system", "subtype": "init", "session_id": "s1" })]);
        assert_eq!(events, vec![AgentEvent::SessionStarted { session_id: "s1".into() }]);
    }

    #[test]
    fn text_deltas_then_result() {
        let (events, end) = feed(&[
            json!({ "type": "system", "subtype": "init" }),
            block_start("text"),
            text_delta("Hel"),
            text_delta("lo"),
            json!({ "type": "assistant", "message": { "content": [{ "type": "text", "text": "Hello" }] } }),
            success("Hello"),
        ]);
        assert_eq!(end, Some(TurnEnd { error: None }));
        assert_eq!(events, vec![text("Hel"), text("lo")]);
    }

    #[test]
    fn thinking_streams_as_reasoning() {
        let (events, _) = feed(&[
            block_start("thinking"),
            delta("thinking_delta", "thinking", "Hmm"),
            block_start("text"),
            text_delta("Hi"),
        ]);
        assert_eq!(
            events,
            vec![AgentEvent::ReasoningDelta { text: "Hmm".into() }, text("Hi")]
        );
    }

    #[test]
    fn back_to_back_text_blocks_start_a_paragraph() {
        let (events, _) = feed(&[block_start("text"), text_delta("a"), block_start("text"), text_delta("b")]);
        assert_eq!(events, vec![text("a"), text("\n\n"), text("b")]);
    }

    #[test]
    fn tool_use_and_its_result() {
        let (events, _) = feed(&[
            json!({ "type": "assistant", "message": { "content": [
                { "type": "tool_use", "id": "toolu_1", "name": "Bash", "input": { "command": "ls" } },
                { "type": "tool_use", "id": "toolu_2", "name": "mcp__github__get_me", "input": {} },
            ] } }),
            json!({ "type": "user", "message": { "content": [
                { "type": "tool_result", "tool_use_id": "toolu_1", "is_error": true,
                  "content": [{ "type": "text", "text": "nope" }] },
            ] } }),
        ]);
        assert_eq!(
            events,
            vec![
                AgentEvent::ToolCall {
                    id: "toolu_1".into(),
                    call: ToolCall::Exec { command: "ls".into() },
                },
                AgentEvent::ToolCall {
                    id: "toolu_2".into(),
                    call: ToolCall::Mcp {
                        server: "github".into(),
                        tool: "get_me".into(),
                        input: Some(json!({})),
                    },
                },
                AgentEvent::ToolResult {
                    id: "toolu_1".into(),
                    is_error: true,
                    output: Some("nope".into()),
                },
            ]
        );
    }

    #[test]
    fn decodes_claudes_tools() {
        let edit = decode_tool_use(
            "Edit",
            &json!({ "file_path": "/a.rs", "old_string": "x", "new_string": "y" }),
        );
        assert_eq!(
            edit,
            ToolCall::EditFile {
                path: "/a.rs".into(),
                old_string: Some("x".into()),
                new_string: Some("y".into()),
            }
        );
        let todo = decode_tool_use(
            "TodoWrite",
            &json!({ "todos": [{ "content": "Ship", "status": "in_progress" }] }),
        );
        assert_eq!(
            todo,
            ToolCall::Todo {
                items: vec![TodoItem {
                    text: "Ship".into(),
                    status: TodoStatus::InProgress,
                }],
            }
        );
        assert!(matches!(decode_tool_use("Frobnicate", &Value::Null), ToolCall::Unknown { input: None, .. }));
    }

    #[test]
    fn subagent_traffic_is_skipped() {
        let mut frame = text_delta("inner");
        frame["parent_tool_use_id"] = "toolu_1".into();
        assert_eq!(feed(&[frame]).0, vec![]);
    }

    #[test]
    fn a_silent_turn_shows_its_result() {
        let (events, _) = feed(&[success("Total cost: $0.01")]);
        assert_eq!(events, vec![text("Total cost: $0.01")]);
    }

    #[test]
    fn assistant_error_codes_read_as_messages() {
        let (events, _) = feed(&[json!({ "type": "assistant", "error": "rate_limit", "message": { "content": [] } })]);
        assert!(matches!(&events[..], [AgentEvent::Error { message }] if message.contains("usage limit")));
    }

    #[test]
    fn failed_result_carries_its_error() {
        let (_, end) = feed(&[json!({
            "type": "result", "subtype": "success", "is_error": true,
            "result": "Invalid API key · Please run /login",
        })]);
        assert_eq!(
            end,
            Some(TurnEnd {
                error: Some("Invalid API key · Please run /login".into())
            })
        );
        let (_, end) = feed(&[json!({
            "type": "result", "subtype": "error_during_execution",
            "errors": ["[ede_diagnostic] x", "boom"],
        })]);
        assert_eq!(end, Some(TurnEnd { error: Some("boom".into()) }));
    }
}
