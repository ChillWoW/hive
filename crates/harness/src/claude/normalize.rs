//! Claude stdout frames → [`AgentEvent`]s.

use std::collections::{BTreeMap, HashMap, HashSet};

use outcode_proto::{
    AgentEvent, BackgroundTask, BackgroundTaskKind, CompactionStatus, DoneStatus, FinishedTask, TaskEnd,
    TodoItem, TodoStatus, ToolCall,
};
use serde_json::Value;

use super::wire::{Frame, ResultFrame};

/// A `result` frame: the turn is over.
#[derive(Debug, PartialEq)]
pub(super) struct TurnEnd {
    /// Why it failed, when it did.
    pub error: Option<String>,
}

/// A session's normalization state. Turn-scoped fields reset in
/// [`Normalizer::end_turn`].
#[derive(Default)]
pub(super) struct Normalizer {
    /// The last top-level event was text: another text block starts a new
    /// paragraph.
    after_text: bool,
    /// The turn streamed text, or compacted: its `result` isn't a reply.
    spoke: bool,
    /// The turn is one the CLI started on its own; its `result` is never a
    /// reply.
    quiet: bool,
    /// The model the last top-level message came from.
    last_model: Option<String>,
    /// Ids of `Agent`/`Task` spawn calls: `task_notification` settles
    /// background shells through the same subtype, so only these settle as
    /// subagents.
    spawns: HashSet<String>,
    /// The live background tasks, as last reported.
    background: Vec<BackgroundTask>,
    /// Task id → the tool call that started it (`task_started`, which may
    /// come before or after the task is first listed).
    task_tools: HashMap<String, String>,
    /// Task id → the file a background shell's output goes to, as its
    /// `Bash` result names it.
    task_outputs: HashMap<String, String>,
    /// Tasks that ended since the last turn: what a turn the CLI starts on
    /// its own is about.
    finished: Vec<FinishedTask>,
}

impl Normalizer {
    /// The events `frame` makes, and the turn's end when it's the `result`.
    pub fn frame(&mut self, frame: Frame) -> (Vec<AgentEvent>, Option<TurnEnd>) {
        let events = match frame {
            Frame::System(f) => self.system(*f),
            Frame::StreamEvent(f) => {
                let parent = f.parent_tool_use_id.as_deref();
                let event = &f.event;
                let mut out = Vec::new();
                match event.kind.as_str() {
                    // The prompt's size is known as the reply starts; the
                    // `assistant` frame repeats it only once a block is whole.
                    "message_start" if parent.is_none() => {
                        if let Some(tokens) = event.message.usage.as_ref().and_then(context_tokens) {
                            out.push(AgentEvent::ContextUsage {
                                tokens: Some(tokens),
                                window: None,
                            });
                        }
                    }
                    "content_block_start"
                        if parent.is_none()
                            && event.content_block["type"] == "text"
                            && self.after_text =>
                    {
                        out.push(text("\n\n"));
                    }
                    "content_block_delta" => {
                        let delta = &event.delta;
                        match delta.kind.as_str() {
                            "text_delta" if !delta.text.is_empty() => {
                                if parent.is_none() {
                                    self.spoke = true;
                                }
                                out.push(attribute(parent, text(&delta.text)));
                            }
                            "thinking_delta" if !delta.thinking.is_empty() => out.push(attribute(
                                parent,
                                AgentEvent::ReasoningDelta {
                                    text: delta.thinking.clone(),
                                },
                            )),
                            _ => {}
                        }
                    }
                    _ => {}
                }
                out
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
                        "text" if parent.is_some() && !block.text.trim().is_empty() => {
                            out.push(attribute(parent, text(&format!("{}\n\n", block.text.trim_end()))));
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
            // User frames carry tool results; our own prompts aren't echoed.
            Frame::User(f) => {
                let parent = f.parent_tool_use_id.as_deref();
                let mut out = Vec::new();
                let mut listed = false;
                for b in f.message.blocks().filter(|b| b.kind == "tool_result") {
                    let output = b.result_text();
                    if let Some((task, file)) = output.as_deref().and_then(background_output) {
                        listed |= self.task_output(task, file);
                    }
                    out.push(attribute(
                        parent,
                        AgentEvent::ToolResult {
                            output,
                            is_error: b.is_error.unwrap_or(false),
                            id: b.tool_use_id,
                        },
                    ));
                }
                // Listed already: report it again with its output file.
                if listed {
                    out.push(self.background_event());
                }
                out
            }
            Frame::RateLimit(f) if f.rate_limit_info.blocks() => {
                let window = rate_window_label(f.rate_limit_info.rate_limit_type.as_deref().unwrap_or(""));
                vec![AgentEvent::Error {
                    message: format!("Claude {window} limit reached; try again after it resets."),
                }]
            }
            Frame::Result(f) => return self.result(&f),
            Frame::RateLimit(_)
            | Frame::ControlRequest(_)
            | Frame::ControlResponse(_)
            | Frame::PromptSuggestion(_)
            | Frame::Other => {
                Vec::new()
            }
        };
        if let Some(last) = events.iter().rev().find(|e| !matches!(e, AgentEvent::Subagent { .. })) {
            self.after_text = matches!(last, AgentEvent::TextDelta { .. });
        }
        (events, None)
    }

    fn system(&mut self, f: super::wire::SystemFrame) -> Vec<AgentEvent> {
        match f.subtype.as_str() {
            "init" if !f.session_id.is_empty() => vec![AgentEvent::SessionStarted {
                session_id: f.session_id,
            }],
            // A background subagent's only terminal signal: its stream just
            // stops, then this arrives untagged.
            "task_notification" => {
                if let Some(task) = &f.task_id {
                    self.task_tools.remove(task);
                    self.task_outputs.remove(task);
                    if let Some(end) = f.status.as_deref().and_then(task_end) {
                        let description = self
                            .background
                            .iter()
                            .find(|t| &t.id == task)
                            .map(|t| t.description.clone())
                            .filter(|d| !d.is_empty())
                            .or_else(|| f.summary.clone())
                            .unwrap_or_default();
                        self.finished.push(FinishedTask {
                            description,
                            status: end,
                        });
                    }
                }
                let Some(parent) = f.tool_use_id.filter(|id| self.spawns.contains(id)) else {
                    return Vec::new();
                };
                let status = match f.status.as_deref().and_then(task_end) {
                    Some(TaskEnd::Completed) => DoneStatus::Completed,
                    Some(TaskEnd::Failed) => DoneStatus::Errored,
                    Some(TaskEnd::Stopped) => DoneStatus::Interrupted,
                    None => return Vec::new(),
                };
                vec![tag(&parent, AgentEvent::Done { status })]
            }
            "background_tasks_changed" => {
                let Some(entries) = f.tasks else {
                    return Vec::new();
                };
                self.background = entries
                    .into_iter()
                    .filter(|e| !e.task_id.is_empty())
                    .map(|e| BackgroundTask {
                        kind: task_kind(&e.task_type),
                        description: e.description,
                        tool_call_id: self.task_tools.get(&e.task_id).cloned(),
                        agent_type: e.subagent_type,
                        output_file: self.task_outputs.get(&e.task_id).cloned(),
                        id: e.task_id,
                    })
                    .collect();
                vec![self.background_event()]
            }
            "task_started" => {
                let (Some(task), Some(tool)) = (f.task_id, f.tool_use_id) else {
                    return Vec::new();
                };
                // Listed already: report it again with its tool call.
                let listed = self
                    .background
                    .iter_mut()
                    .find(|t| t.id == task && t.tool_call_id.is_none());
                let changed = listed.map(|t| t.tool_call_id = Some(tool.clone())).is_some();
                self.task_tools.insert(task, tool);
                if changed {
                    vec![self.background_event()]
                } else {
                    Vec::new()
                }
            }
            // `compacting` as a compaction starts; how it ended once it has
            // (a success also gets a `compact_boundary`).
            "status" => {
                if f.status.as_deref() == Some("compacting") {
                    self.spoke = true;
                    return compaction(CompactionStatus::Running, None);
                }
                match f.compact_result.as_deref() {
                    None | Some("success") => Vec::new(),
                    Some("failed") => compaction(
                        CompactionStatus::Failed,
                        f.compact_error.filter(|e| !e.trim().is_empty()),
                    ),
                    Some(_) => compaction(CompactionStatus::Stopped, None),
                }
            }
            "compact_boundary" => {
                self.spoke = true;
                let meta = f.compact_metadata.unwrap_or_default();
                let mut out = vec![AgentEvent::Compaction {
                    status: CompactionStatus::Completed,
                    auto: meta.trigger == "auto",
                    before_tokens: meta.pre_tokens,
                    after_tokens: meta.post_tokens,
                    error: None,
                }];
                if let Some(tokens) = meta.post_tokens {
                    out.push(AgentEvent::ContextUsage {
                        tokens: Some(tokens),
                        window: None,
                    });
                }
                out
            }
            _ => Vec::new(),
        }
    }

    fn result(&mut self, f: &ResultFrame) -> (Vec<AgentEvent>, Option<TurnEnd>) {
        let mut out = Vec::new();
        let failed = f.is_error || f.subtype != "success";
        let reply = f.result.as_deref().map(str::trim).filter(|t| !t.is_empty());
        // A local command (`/context`, `/cost`, …) answers only here; a model
        // turn's text already streamed. A `/compact` that never started says
        // why here too.
        if !failed && !self.spoke && !self.quiet
            && let Some(reply) = reply
        {
            out.push(if f.local_command.as_deref() == Some("compact") {
                AgentEvent::Compaction {
                    status: CompactionStatus::Failed,
                    auto: false,
                    before_tokens: None,
                    after_tokens: None,
                    error: Some(reply.to_owned()),
                }
            } else {
                text(reply)
            });
        }
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
        let error = failed.then(|| result_error(f));
        (out, Some(TurnEnd { error }))
    }

    /// The context window of the model the turn ran on, from the result's
    /// per-model usage.
    fn context_window(&self, model_usage: &BTreeMap<String, Value>) -> Option<u64> {
        let entry = self
            .last_model
            .as_ref()
            .and_then(|model| model_usage.get(model))
            .or_else(|| (model_usage.len() == 1).then(|| model_usage.values().next()).flatten())?;
        entry.get("contextWindow").and_then(Value::as_u64).filter(|n| *n > 0)
    }

    /// A turn the CLI started on its own: what ended since the last turn,
    /// for the turn they woke. Its `result` isn't shown as a reply.
    pub fn start_background_turn(&mut self) -> Vec<FinishedTask> {
        self.quiet = true;
        std::mem::take(&mut self.finished)
    }

    /// The turn ended: what ended during it was its to deal with.
    pub fn end_turn(&mut self) {
        self.after_text = false;
        self.spoke = false;
        self.quiet = false;
        self.finished.clear();
    }

    /// Whether background tasks are live.
    pub fn has_background(&self) -> bool {
        !self.background.is_empty()
    }

    /// Notes where background shell `task` writes its output; true when the
    /// task is listed and hadn't one yet.
    fn task_output(&mut self, task: &str, file: &str) -> bool {
        self.task_outputs.insert(task.to_owned(), file.to_owned());
        let listed = self
            .background
            .iter_mut()
            .find(|t| t.id == task && t.output_file.is_none());
        listed.map(|t| t.output_file = Some(file.to_owned())).is_some()
    }

    fn background_event(&self) -> AgentEvent {
        AgentEvent::BackgroundTasks {
            tasks: self.background.clone(),
        }
    }
}

fn text(text: &str) -> AgentEvent {
    AgentEvent::TextDelta { text: text.into() }
}

/// A compaction starting or ending without numbers (`status` frames).
fn compaction(status: CompactionStatus, error: Option<String>) -> Vec<AgentEvent> {
    vec![AgentEvent::Compaction {
        status,
        auto: false,
        before_tokens: None,
        after_tokens: None,
        error,
    }]
}

/// A `task_notification` status; `None` while it hasn't ended.
fn task_end(status: &str) -> Option<TaskEnd> {
    Some(match status {
        "completed" | "complete" | "succeeded" | "success" => TaskEnd::Completed,
        "failed" | "errored" | "error" => TaskEnd::Failed,
        "killed" | "cancelled" | "canceled" | "stopped" | "interrupted" => TaskEnd::Stopped,
        _ => return None,
    })
}

/// A background shell's task id and output file, from its `Bash` result:
/// "Command running in background with ID: <id>. Output is being written
/// to: <dir>/tasks/<id>.output. …".
fn background_output(result: &str) -> Option<(&str, &str)> {
    let rest = result.strip_prefix("Command running in background with ID: ")?;
    let (task, rest) = rest.split_once(". Output is being written to: ")?;
    let end = rest.rfind(".output")? + ".output".len();
    Some((task, &rest[..end]))
}

/// A `background_tasks_changed` entry's `task_type`.
fn task_kind(task_type: &str) -> BackgroundTaskKind {
    match task_type {
        "local_agent" | "remote_agent" | "in_process_teammate" => BackgroundTaskKind::Agent,
        "local_bash" => BackgroundTaskKind::Shell,
        "monitor" | "monitor_mcp" => BackgroundTaskKind::Monitor,
        _ => BackgroundTaskKind::Other,
    }
}

/// Subagent traffic arrives on the same stdout, tagged with the spawn call's
/// id; it folds into the spawn, not the parent transcript.
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
    let counts: Vec<u64> = ["input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"]
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
pub(super) fn decode_tool_use(name: &str, input: &Value) -> ToolCall {
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
                .map_or(&[][..], Vec::as_slice)
                .iter()
                .map(|t| TodoItem {
                    text: str_field(t, "content"),
                    status: TodoStatus::parse(t.get("status").and_then(Value::as_str).unwrap_or("")),
                })
                .collect(),
        },
        _ if is_spawn(name) => ToolCall::Subagent {
            description: str_field(input, "description"),
            model: opt_str_field(input, "model"),
            prompt: opt_str_field(input, "prompt"),
            agent: opt_str_field(input, "subagent_type"),
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

fn rate_window_label(kind: &str) -> &'static str {
    match kind {
        "five_hour" => "5-hour",
        "seven_day" | "seven_day_overage_included" => "weekly",
        "seven_day_opus" => "weekly (Opus)",
        "seven_day_sonnet" => "weekly (Sonnet)",
        _ => "usage",
    }
}

/// What a failed `result` says went wrong, never blank. The CLI mixes
/// internal `[ede_diagnostic]` breadcrumbs into `errors`; those are dropped.
fn result_error(f: &ResultFrame) -> String {
    if let Some(result) = f.result.as_deref().filter(|r| !r.trim().is_empty()) {
        return result.trim().to_owned();
    }
    let errors: Vec<String> = f
        .errors
        .iter()
        .map(|e| e.as_str().map_or_else(|| e.to_string(), str::to_owned))
        .filter(|m| !m.contains("[ede_diagnostic]"))
        .collect();
    if !errors.is_empty() {
        return errors.join("\n");
    }
    match f.subtype.as_str() {
        "error_max_turns" => "The run hit the maximum number of turns.".into(),
        "error_max_budget_usd" => "The run hit its cost budget.".into(),
        _ => "Claude's turn failed.".into(),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::super::wire::parse_frame;
    use super::*;

    fn feed(n: &mut Normalizer, frames: &[Value]) -> (Vec<AgentEvent>, Option<TurnEnd>) {
        let mut events = Vec::new();
        for frame in frames {
            let (out, end) = n.frame(parse_frame(&frame.to_string()).unwrap());
            events.extend(out);
            if end.is_some() {
                return (events, end);
            }
        }
        (events, None)
    }

    fn run(frames: &[Value]) -> (Vec<AgentEvent>, Option<TurnEnd>) {
        feed(&mut Normalizer::default(), frames)
    }

    fn delta(kind: &str, field: &str, text: &str) -> Value {
        json!({
            "type": "stream_event",
            "event": { "type": "content_block_delta", "index": 0, "delta": { "type": kind, field: text } },
        })
    }

    fn text_delta(t: &str) -> Value {
        delta("text_delta", "text", t)
    }

    fn block_start(kind: &str) -> Value {
        json!({ "type": "stream_event", "event": { "type": "content_block_start", "content_block": { "type": kind } } })
    }

    fn success(result: &str) -> Value {
        json!({ "type": "result", "subtype": "success", "is_error": false, "result": result })
    }

    /// The events but the usage every result reports.
    fn content(events: Vec<AgentEvent>) -> Vec<AgentEvent> {
        events
            .into_iter()
            .filter(|e| !matches!(e, AgentEvent::Usage { .. }))
            .collect()
    }

    #[test]
    fn init_reports_the_session() {
        let (events, _) = run(&[json!({ "type": "system", "subtype": "init", "session_id": "s1" })]);
        assert_eq!(events, vec![AgentEvent::SessionStarted { session_id: "s1".into() }]);
    }

    #[test]
    fn text_deltas_then_result() {
        let (events, end) = run(&[
            block_start("text"),
            text_delta("Hel"),
            text_delta("lo"),
            json!({ "type": "assistant", "message": { "content": [{ "type": "text", "text": "Hello" }] } }),
            success("Hello"),
        ]);
        assert_eq!(end, Some(TurnEnd { error: None }));
        assert_eq!(content(events), vec![text("Hel"), text("lo")]);
    }

    #[test]
    fn thinking_streams_as_reasoning_and_text_blocks_split_paragraphs() {
        let (events, _) = run(&[
            block_start("thinking"),
            delta("thinking_delta", "thinking", "Hmm"),
            block_start("text"),
            text_delta("a"),
            block_start("text"),
            text_delta("b"),
        ]);
        assert_eq!(
            events,
            vec![
                AgentEvent::ReasoningDelta { text: "Hmm".into() },
                text("a"),
                text("\n\n"),
                text("b")
            ]
        );
    }

    #[test]
    fn tool_use_and_its_result() {
        let (events, _) = run(&[
            json!({ "type": "assistant", "message": { "content": [
                { "type": "tool_use", "id": "toolu_1", "name": "Bash", "input": { "command": "ls" } },
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
                AgentEvent::ToolResult {
                    id: "toolu_1".into(),
                    is_error: true,
                    output: Some("nope".into()),
                },
            ]
        );
    }

    #[test]
    fn a_silent_turn_shows_its_result() {
        let (events, _) = run(&[success("Total cost: $0.01")]);
        assert_eq!(content(events), vec![text("Total cost: $0.01")]);
    }

    #[test]
    fn a_compaction_that_never_started_fails_with_the_reason() {
        let (events, _) = run(&[json!({
            "type": "result", "subtype": "success",
            "result": "Not enough messages to compact.", "local_command": "compact",
        })]);
        assert!(matches!(
            events.first(),
            Some(AgentEvent::Compaction { status: CompactionStatus::Failed, error: Some(e), .. }) if e.starts_with("Not enough")
        ));
    }

    #[test]
    fn compaction_runs_then_lands_with_its_numbers() {
        let (events, _) = run(&[
            json!({ "type": "system", "subtype": "status", "status": "compacting" }),
            json!({ "type": "system", "subtype": "compact_boundary",
                    "compact_metadata": { "trigger": "auto", "pre_tokens": 1000, "post_tokens": 200 } }),
            json!({ "type": "result", "subtype": "success", "result": "Compacted", "local_command": "compact" }),
        ]);
        assert!(matches!(
            &events[..],
            [
                AgentEvent::Compaction { status: CompactionStatus::Running, .. },
                AgentEvent::Compaction { status: CompactionStatus::Completed, auto: true, after_tokens: Some(200), .. },
                AgentEvent::ContextUsage { tokens: Some(200), .. },
                AgentEvent::Usage { .. },
            ]
        ));
    }

    #[test]
    fn subagent_traffic_is_tagged_and_settled_by_its_notification() {
        let mut n = Normalizer::default();
        feed(
            &mut n,
            &[json!({ "type": "assistant", "message": { "content": [
                { "type": "tool_use", "id": "spawn", "name": "Agent", "input": { "description": "scan", "prompt": "p" } }
            ] } })],
        );
        let (inner, _) = feed(
            &mut n,
            &[json!({ "type": "assistant", "parent_tool_use_id": "spawn", "message": { "content": [
                { "type": "text", "text": "looking" }
            ] } })],
        );
        assert!(matches!(
            inner.as_slice(),
            [AgentEvent::Subagent { parent_tool_id, event }]
                if parent_tool_id == "spawn" && matches!(**event, AgentEvent::TextDelta { .. })
        ));
        let (done, _) = feed(
            &mut n,
            &[json!({ "type": "system", "subtype": "task_notification", "tool_use_id": "spawn", "status": "completed" })],
        );
        assert!(matches!(
            done.as_slice(),
            [AgentEvent::Subagent { event, .. }] if matches!(**event, AgentEvent::Done { status: DoneStatus::Completed })
        ));
        // A background shell settling through the same subtype is no subagent.
        let (shell, _) = feed(
            &mut n,
            &[json!({ "type": "system", "subtype": "task_notification", "tool_use_id": "bash1", "status": "completed" })],
        );
        assert!(shell.is_empty());
    }

    #[test]
    fn background_tasks_are_reported_as_a_set_with_their_tool_call() {
        let mut n = Normalizer::default();
        let (listed, _) = feed(
            &mut n,
            &[json!({ "type": "system", "subtype": "background_tasks_changed", "tasks": [
                { "task_id": "b1", "task_type": "local_bash", "description": "Run dev server" }
            ] })],
        );
        let [AgentEvent::BackgroundTasks { tasks }] = listed.as_slice() else {
            panic!("{listed:?}");
        };
        assert_eq!(tasks[0].kind, BackgroundTaskKind::Shell);
        assert_eq!(tasks[0].tool_call_id, None);
        let (started, _) = feed(
            &mut n,
            &[json!({ "type": "system", "subtype": "task_started", "task_id": "b1", "tool_use_id": "toolu_1" })],
        );
        assert!(matches!(
            started.as_slice(),
            [AgentEvent::BackgroundTasks { tasks }] if tasks[0].tool_call_id.as_deref() == Some("toolu_1")
        ));
        assert!(n.has_background());
        // The shell's result says where its output goes.
        let (ran, _) = feed(
            &mut n,
            &[json!({ "type": "user", "message": { "content": [{
                "type": "tool_result",
                "tool_use_id": "toolu_1",
                "content": "Command running in background with ID: b1. Output is being written to: \
                            C:\\tmp\\claude\\tasks\\b1.output. You will be notified when it completes.",
            }] } })],
        );
        assert!(matches!(
            ran.as_slice(),
            [AgentEvent::ToolResult { .. }, AgentEvent::BackgroundTasks { tasks }]
                if tasks[0].output_file.as_deref() == Some("C:\\tmp\\claude\\tasks\\b1.output")
        ));
        feed(
            &mut n,
            &[
                json!({ "type": "system", "subtype": "task_notification", "task_id": "b1", "status": "failed" }),
                json!({ "type": "system", "subtype": "background_tasks_changed", "tasks": [] }),
            ],
        );
        assert!(!n.has_background());
        assert_eq!(
            n.start_background_turn(),
            vec![FinishedTask {
                description: "Run dev server".into(),
                status: TaskEnd::Failed
            }]
        );
        // The woken turn's result isn't a reply.
        let (events, _) = feed(&mut n, &[success("Checked the server.")]);
        assert_eq!(content(events), vec![]);
    }

    #[test]
    fn context_usage_from_messages_and_the_window_from_the_result() {
        let (events, _) = run(&[
            json!({ "type": "assistant", "message": { "model": "claude-x", "content": [],
                    "usage": { "input_tokens": 10, "cache_read_input_tokens": 90 } } }),
            json!({ "type": "result", "subtype": "success", "result": "",
                    "usage": { "input_tokens": 10, "output_tokens": 5 },
                    "modelUsage": { "claude-x": { "contextWindow": 200000 } } }),
        ]);
        assert_eq!(
            events,
            vec![
                AgentEvent::ContextUsage { tokens: Some(100), window: None },
                AgentEvent::ContextUsage { tokens: None, window: Some(200_000) },
                AgentEvent::Usage { input_tokens: 10, output_tokens: 5 },
            ]
        );
    }

    #[test]
    fn context_usage_as_a_message_starts() {
        let (events, _) = feed(
            &mut Normalizer::default(),
            &[json!({ "type": "stream_event", "event": { "type": "message_start", "message": {
                "usage": { "input_tokens": 10, "cache_read_input_tokens": 90, "cache_creation_input_tokens": 20 } } } })],
        );
        assert_eq!(events, vec![AgentEvent::ContextUsage { tokens: Some(120), window: None }]);
    }

    #[test]
    fn assistant_error_codes_read_as_messages() {
        let (events, _) = run(&[json!({ "type": "assistant", "error": "rate_limit", "message": { "content": [] } })]);
        assert!(matches!(&events[..], [AgentEvent::Error { message }] if message.contains("usage limit")));
    }

    #[test]
    fn failed_result_carries_its_error() {
        let (_, end) = run(&[json!({
            "type": "result", "subtype": "success", "is_error": true,
            "result": "Invalid API key · Please run /login",
        })]);
        assert_eq!(end, Some(TurnEnd { error: Some("Invalid API key · Please run /login".into()) }));
        let (_, end) = run(&[json!({
            "type": "result", "subtype": "error_during_execution", "errors": ["[ede_diagnostic] x", "boom"],
        })]);
        assert_eq!(end, Some(TurnEnd { error: Some("boom".into()) }));
    }

    #[test]
    fn decodes_claudes_tools() {
        assert_eq!(
            decode_tool_use("Edit", &json!({ "file_path": "/a.rs", "old_string": "x", "new_string": "y" })),
            ToolCall::EditFile {
                path: "/a.rs".into(),
                old_string: Some("x".into()),
                new_string: Some("y".into()),
            }
        );
        assert_eq!(
            decode_tool_use("Task", &json!({ "description": "scan", "prompt": "Scan it.", "subagent_type": "Explore" })),
            ToolCall::Subagent {
                description: "scan".into(),
                model: None,
                prompt: Some("Scan it.".into()),
                agent: Some("Explore".into())
            }
        );
        assert!(matches!(
            decode_tool_use("mcp__github__get_me", &json!({})),
            ToolCall::Mcp { server, tool, .. } if server == "github" && tool == "get_me"
        ));
        assert!(matches!(decode_tool_use("Frobnicate", &Value::Null), ToolCall::Unknown { input: None, .. }));
    }
}
