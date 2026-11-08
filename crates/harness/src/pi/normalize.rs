//! Pi's session events (`message_update`, `tool_execution_*`,
//! `compaction_*`, …) as [`AgentEvent`]s.

use std::collections::{HashMap, HashSet};

use hive_proto::{AgentEvent, CompactionStatus, DoneStatus, ToolCall, ToolDiff};
use serde_json::Value;

/// Most of a tool's output kept for the transcript.
const OUTPUT_CAP: usize = 64 * 1024;

#[derive(Default)]
pub(super) struct Normalizer {
    /// Text and thinking streamed so far, per content block of the message
    /// in flight: its `message_end` adds only what the deltas missed.
    text: HashMap<usize, String>,
    thinking: HashMap<usize, String>,
    /// Tool calls reported, with their name and arguments for the result.
    tools: HashMap<String, (String, Value)>,
    reported: HashSet<String>,
    /// The turn's last provider error, cleared by a later good message (a
    /// retry that worked).
    pub error: Option<String>,
    /// The model's context window, for [`AgentEvent::ContextUsage`].
    pub window: Option<u64>,
    /// A compaction reported running and not yet ended.
    compacting: bool,
    input_tokens: u64,
    output_tokens: u64,
}

impl Normalizer {
    /// A new turn starts.
    pub fn start_turn(&mut self) {
        self.error = None;
        self.input_tokens = 0;
        self.output_tokens = 0;
    }

    /// How the turn ended, by `agent_settled`'s `aborted` and the last error.
    pub fn status(&self, aborted: bool) -> (DoneStatus, Option<String>) {
        if aborted {
            (DoneStatus::Interrupted, None)
        } else if let Some(error) = &self.error {
            (DoneStatus::Errored, Some(error.clone()))
        } else {
            (DoneStatus::Completed, None)
        }
    }

    /// Reports a compaction started (`/compact`, or Pi on its own).
    pub fn compaction_started(&mut self, auto: bool) -> Option<AgentEvent> {
        if self.compacting {
            return None;
        }
        self.compacting = true;
        Some(AgentEvent::Compaction {
            status: CompactionStatus::Running,
            auto,
            before_tokens: None,
            after_tokens: None,
            error: None,
        })
    }

    /// Ends a compaction reported running: `result` is a compaction result
    /// (`tokensBefore`, `estimatedTokensAfter`), else it failed with `error`
    /// or was stopped.
    pub fn compaction_ended(
        &mut self,
        result: Option<&Value>,
        error: Option<String>,
        auto: bool,
    ) -> Vec<AgentEvent> {
        if !self.compacting {
            return Vec::new();
        }
        self.compacting = false;
        let mut events = Vec::new();
        let (status, before, after) = match result {
            Some(r) => (
                CompactionStatus::Completed,
                r["tokensBefore"].as_u64(),
                r["estimatedTokensAfter"].as_u64(),
            ),
            None if error.is_some() => (CompactionStatus::Failed, None, None),
            None => (CompactionStatus::Stopped, None, None),
        };
        events.push(AgentEvent::Compaction {
            status,
            auto,
            before_tokens: before,
            after_tokens: after,
            error,
        });
        if let Some(after) = after {
            events.push(AgentEvent::ContextUsage {
                tokens: Some(after),
                window: self.window,
            });
        }
        events
    }

    pub fn map(&mut self, frame: &Value) -> Vec<AgentEvent> {
        let mut events = Vec::new();
        match string(frame, "type") {
            "message_start" if frame["message"]["role"] == "assistant" => {
                self.text.clear();
                self.thinking.clear();
            }
            "message_update" => {
                let update = &frame["assistantMessageEvent"];
                let index = update["contentIndex"].as_u64().unwrap_or(0) as usize;
                let delta = string(update, "delta");
                match string(update, "type") {
                    "text_delta" if !delta.is_empty() => {
                        self.text.entry(index).or_default().push_str(delta);
                        events.push(AgentEvent::TextDelta { text: delta.into() });
                    }
                    "thinking_delta" if !delta.is_empty() => {
                        self.thinking.entry(index).or_default().push_str(delta);
                        events.push(AgentEvent::ReasoningDelta { text: delta.into() });
                    }
                    "toolcall_end" => {
                        let call = &update["toolCall"];
                        events.extend(self.tool_call(
                            string(call, "id"),
                            string(call, "name"),
                            &call["arguments"],
                        ));
                    }
                    _ => {}
                }
            }
            "message_end" if frame["message"]["role"] == "assistant" => {
                self.message_end(&frame["message"], &mut events);
            }
            "tool_execution_start" => {
                events.extend(self.tool_call(
                    string(frame, "toolCallId"),
                    string(frame, "toolName"),
                    &frame["args"],
                ));
            }
            "tool_execution_end" => {
                let id = string(frame, "toolCallId").to_owned();
                let is_error = frame["isError"].as_bool().unwrap_or(false);
                let info = self.tools.remove(&id);
                let output = text_of(&frame["result"]["content"]);
                let diff = info
                    .filter(|_| !is_error)
                    .and_then(|(name, args)| diff_of(&name, &args));
                events.push(AgentEvent::ToolResult {
                    id,
                    is_error,
                    output: (!output.is_empty()).then(|| cap(&output)),
                    diff,
                });
            }
            "compaction_start" => {
                let auto = string(frame, "reason") != "manual";
                events.extend(self.compaction_started(auto));
            }
            "compaction_end" => {
                let auto = string(frame, "reason") != "manual";
                let result = frame.get("result").filter(|r| r.is_object());
                let error = frame["errorMessage"].as_str().map(str::to_owned);
                events.extend(self.compaction_ended(result, error, auto));
            }
            // A throwing extension handler is the extension's failure; the
            // run goes on.
            "extension_error" => events.push(AgentEvent::Error {
                message: format!("Pi extension: {}", string(frame, "error")),
            }),
            _ => {}
        }
        events
    }

    fn message_end(&mut self, message: &Value, events: &mut Vec<AgentEvent>) {
        match string(message, "stopReason") {
            "error" => {
                self.error = Some(
                    message["errorMessage"]
                        .as_str()
                        .filter(|e| !e.is_empty())
                        .unwrap_or("Pi's model request failed.")
                        .to_owned(),
                );
            }
            "aborted" => {}
            _ => self.error = None,
        }
        // What the deltas missed (a provider that doesn't stream).
        for (index, part) in message["content"].as_array().into_iter().flatten().enumerate() {
            let (seen, value, reasoning) = match string(part, "type") {
                "text" => (&mut self.text, string(part, "text"), false),
                "thinking" => (&mut self.thinking, string(part, "thinking"), true),
                _ => continue,
            };
            let previous = seen.entry(index).or_default();
            if let Some(rest) = value.strip_prefix(previous.as_str()).filter(|s| !s.is_empty()) {
                let text = rest.to_owned();
                events.push(if reasoning {
                    AgentEvent::ReasoningDelta { text }
                } else {
                    AgentEvent::TextDelta { text }
                });
            }
            *previous = value.to_owned();
        }
        let usage = &message["usage"];
        if usage.is_object() {
            let n = |key: &str| usage[key].as_u64().unwrap_or(0);
            let input = n("input") + n("cacheRead") + n("cacheWrite");
            let output = n("output");
            if input + output > 0 {
                self.input_tokens += input;
                self.output_tokens += output;
                events.push(AgentEvent::Usage {
                    input_tokens: self.input_tokens,
                    output_tokens: self.output_tokens,
                });
                events.push(AgentEvent::ContextUsage {
                    tokens: Some(input + output),
                    window: self.window,
                });
            }
        }
    }

    /// A tool call, once: the model's message and the run both name it.
    fn tool_call(&mut self, id: &str, name: &str, args: &Value) -> Option<AgentEvent> {
        if id.is_empty() || !self.reported.insert(id.to_owned()) {
            return None;
        }
        self.tools.insert(id.to_owned(), (name.to_owned(), args.clone()));
        Some(AgentEvent::ToolCall {
            id: id.to_owned(),
            call: tool(name, args),
        })
    }
}

pub(super) fn string<'a>(v: &'a Value, key: &str) -> &'a str {
    v[key].as_str().unwrap_or("")
}

/// The text blocks of a tool result's content.
fn text_of(content: &Value) -> String {
    content
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|c| c["text"].as_str())
        .collect::<Vec<_>>()
        .join("\n")
}

fn cap(text: &str) -> String {
    if text.len() <= OUTPUT_CAP {
        return text.to_owned();
    }
    let mut at = OUTPUT_CAP;
    while !text.is_char_boundary(at) {
        at -= 1;
    }
    format!("{}\n… [truncated]", &text[..at])
}

/// An `edit`'s replacements, old and new, each joined.
fn edits(args: &Value) -> Option<(String, String)> {
    let list: Vec<&Value> = match args["edits"].as_array() {
        Some(list) => list.iter().collect(),
        // Older Pi: one replacement, inline.
        None if args.get("oldText").is_some() => vec![args],
        None => return None,
    };
    let join = |key: &str| {
        list.iter()
            .map(|e| string(e, key))
            .collect::<Vec<_>>()
            .join("\n")
    };
    Some((join("oldText"), join("newText")))
}

fn diff_of(name: &str, args: &Value) -> Option<ToolDiff> {
    let path = string(args, "path").to_owned();
    match name {
        "edit" => {
            let (old, new) = edits(args)?;
            Some(ToolDiff {
                path,
                old_text: Some(old),
                new_text: new,
            })
        }
        "write" => Some(ToolDiff {
            path,
            old_text: None,
            new_text: string(args, "content").to_owned(),
        }),
        _ => None,
    }
}

fn opt(args: &Value, key: &str) -> Option<String> {
    args[key].as_str().filter(|s| !s.is_empty()).map(str::to_owned)
}

pub(super) fn tool(name: &str, args: &Value) -> ToolCall {
    match name {
        "bash" | "powershell" => ToolCall::Exec {
            command: string(args, "command").into(),
        },
        "read" => ToolCall::ReadFile {
            path: string(args, "path").into(),
        },
        "write" => ToolCall::WriteFile {
            path: string(args, "path").into(),
            content: opt(args, "content"),
        },
        "edit" => {
            let (old, new) = edits(args).unzip();
            ToolCall::EditFile {
                path: string(args, "path").into(),
                old_string: old,
                new_string: new,
            }
        }
        "grep" => ToolCall::Search {
            pattern: string(args, "pattern").into(),
            path: opt(args, "path"),
        },
        "find" => ToolCall::Glob {
            pattern: match opt(args, "path") {
                Some(dir) => format!("{}/{}", dir.trim_end_matches(['/', '\\']), string(args, "pattern")),
                None => string(args, "pattern").into(),
            },
        },
        "ls" => ToolCall::Glob {
            pattern: format!(
                "{}/*",
                opt(args, "path").as_deref().unwrap_or(".").trim_end_matches(['/', '\\'])
            ),
        },
        _ => match name.strip_prefix("mcp__").and_then(|rest| rest.split_once("__")) {
            Some((server, tool)) => ToolCall::Mcp {
                server: server.into(),
                tool: tool.into(),
                input: Some(args.clone()),
            },
            None => ToolCall::Unknown {
                name: name.into(),
                input: Some(args.clone()),
            },
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_final_message_adds_only_what_was_missed() {
        let mut n = Normalizer::default();
        n.map(&json!({"type":"message_start","message":{"role":"assistant"}}));
        n.map(&json!({"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"hel"}}));
        let events = n.map(&json!({"type":"message_end","message":{"role":"assistant","stopReason":"stop","content":[{"type":"text","text":"hello"}],"usage":{"input":10,"output":2,"cacheRead":5,"cacheWrite":0}}}));
        assert!(matches!(&events[0], AgentEvent::TextDelta { text } if text == "lo"));
        assert!(matches!(&events[1], AgentEvent::Usage { input_tokens: 15, output_tokens: 2 }));
        assert_eq!(n.status(false).0, DoneStatus::Completed);
    }

    #[test]
    fn a_retry_that_works_clears_the_error() {
        let mut n = Normalizer::default();
        n.map(&json!({"type":"message_end","message":{"role":"assistant","stopReason":"error","errorMessage":"overloaded","content":[]}}));
        assert_eq!(n.status(false), (DoneStatus::Errored, Some("overloaded".into())));
        n.map(&json!({"type":"message_end","message":{"role":"assistant","stopReason":"stop","content":[]}}));
        assert_eq!(n.status(false).0, DoneStatus::Completed);
        assert_eq!(n.status(true).0, DoneStatus::Interrupted);
    }

    #[test]
    fn tools_are_reported_once_with_their_diff() {
        let mut n = Normalizer::default();
        let args = json!({"path":"a.rs","edits":[{"oldText":"old","newText":"new"}]});
        let call = n.map(&json!({"type":"message_update","assistantMessageEvent":{"type":"toolcall_end","toolCall":{"id":"t","name":"edit","arguments":args}}}));
        assert!(matches!(&call[0], AgentEvent::ToolCall { call: ToolCall::EditFile { new_string: Some(s), .. }, .. } if s == "new"));
        assert!(n.map(&json!({"type":"tool_execution_start","toolCallId":"t","toolName":"edit","args":args})).is_empty());
        let result = n.map(&json!({"type":"tool_execution_end","toolCallId":"t","isError":false,"result":{"content":[{"type":"text","text":"ok"}]}}));
        assert!(matches!(&result[0], AgentEvent::ToolResult { diff: Some(d), output: Some(o), .. } if d.new_text == "new" && o == "ok"));
    }

    #[test]
    fn mcp_tools_name_their_server() {
        assert_eq!(
            tool("mcp__hive__whoami", &json!({})),
            ToolCall::Mcp { server: "hive".into(), tool: "whoami".into(), input: Some(json!({})) }
        );
        assert_eq!(tool("bash", &json!({"command":"ls"})), ToolCall::Exec { command: "ls".into() });
    }

    #[test]
    fn compactions_end_once() {
        let mut n = Normalizer::default();
        assert!(n.map(&json!({"type":"compaction_start","reason":"threshold"})).len() == 1);
        let end = n.map(&json!({"type":"compaction_end","reason":"threshold","result":{"tokensBefore":100,"estimatedTokensAfter":10},"aborted":false}));
        assert!(matches!(&end[0], AgentEvent::Compaction { status: CompactionStatus::Completed, auto: true, after_tokens: Some(10), .. }));
        assert!(n.map(&json!({"type":"compaction_end","reason":"threshold"})).is_empty());
    }
}
