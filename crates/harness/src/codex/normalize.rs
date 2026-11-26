//! App-server notifications → [`AgentEvent`]s.
//!
//! Turn lifecycle (`turn/started`, `turn/completed` on the main thread) is
//! the session's business; this turns items and deltas into transcript
//! events. A subagent's thread is followed once its spawn call names it, and
//! its events come out wrapped in [`AgentEvent::Subagent`]. A plan (plan
//! mode) isn't text: it's kept for the question that offers it.

use std::collections::{HashMap, HashSet};

use outcode_proto::{AgentEvent, CompactionStatus, DoneStatus, TodoItem, TodoStatus, ToolCall};
use serde_json::Value;

#[derive(Default)]
pub(super) struct Normalizer {
    /// The run's own thread.
    thread_id: String,
    /// Subagent threads → the spawn call's id.
    children: HashMap<String, String>,
    /// What each thread streamed last, for separating text blocks.
    last: HashMap<String, Last>,
    /// Items whose deltas came: their completion repeats nothing.
    streamed: HashSet<String>,
    /// Each call as last reported, so a completion repeats only what changed.
    calls: HashMap<String, ToolCall>,
    /// A file change item's paths, for its approval.
    paths: HashMap<String, Vec<String>>,
    /// The turn's plan (plan mode), as far as it came.
    pub plan: String,
    /// The last error the server gave up on, for a failed turn without one.
    pub last_error: Option<String>,
    /// The turn is a `/compact`: a compaction in it isn't automatic.
    pub compact_turn: bool,
}

#[derive(Clone, PartialEq)]
enum Last {
    Text(String),
    Reasoning(String, i64),
    Other,
}

impl Normalizer {
    pub(super) fn new(thread_id: String) -> Self {
        Self {
            thread_id,
            ..Self::default()
        }
    }

    /// The call an item shows as (its first, for a file change), for its
    /// approval.
    pub(super) fn call(&self, item_id: &str) -> Option<&ToolCall> {
        self.calls
            .get(item_id)
            .or_else(|| self.calls.get(&format!("{item_id}:0")))
    }

    /// The files an item changes.
    pub(super) fn paths(&self, item_id: &str) -> &[String] {
        self.paths.get(item_id).map(Vec::as_slice).unwrap_or_default()
    }

    /// Clears per-turn state.
    pub(super) fn start_turn(&mut self) {
        self.plan.clear();
        self.compact_turn = false;
        self.last_error = None;
        self.streamed.clear();
        self.last.remove(&self.thread_id);
    }

    pub(super) fn notification(&mut self, method: &str, params: &Value) -> Vec<AgentEvent> {
        let thread = str_field(params, "threadId").unwrap_or_default().to_owned();
        if thread.is_empty() || thread == self.thread_id {
            return self.events(method, params, &thread, true);
        }
        let Some(parent) = self.children.get(&thread).cloned() else {
            return Vec::new(); // Some other thread's traffic.
        };
        let events = if method == "turn/completed" {
            vec![AgentEvent::Done {
                status: turn_status(&params["turn"]),
            }]
        } else {
            self.events(method, params, &thread, false)
        };
        events
            .into_iter()
            .map(|event| AgentEvent::Subagent {
                parent_tool_id: parent.clone(),
                event: Box::new(event),
            })
            .collect()
    }

    fn events(&mut self, method: &str, params: &Value, thread: &str, main: bool) -> Vec<AgentEvent> {
        let item_id = str_field(params, "itemId").unwrap_or_default();
        let delta = str_field(params, "delta").unwrap_or_default();
        match method {
            "item/agentMessage/delta" => self.text(thread, item_id, delta).into_iter().collect(),
            "item/plan/delta" => {
                self.streamed.insert(item_id.to_owned());
                self.plan.push_str(delta);
                Vec::new()
            }
            "item/reasoning/summaryTextDelta" => {
                let index = params["summaryIndex"].as_i64().unwrap_or(0);
                self.reasoning(thread, item_id, index, delta).into_iter().collect()
            }
            "item/reasoning/textDelta" => {
                let index = params["contentIndex"].as_i64().unwrap_or(0);
                self.reasoning(thread, item_id, index, delta).into_iter().collect()
            }
            "item/started" => self.item(&params["item"], thread, main, false),
            "item/completed" => self.item(&params["item"], thread, main, true),
            "turn/plan/updated" => {
                let turn = str_field(params, "turnId").unwrap_or_default();
                let items = params["plan"]
                    .as_array()
                    .map(Vec::as_slice)
                    .unwrap_or_default()
                    .iter()
                    .map(|step| TodoItem {
                        text: str_field(step, "step").unwrap_or_default().to_owned(),
                        status: TodoStatus::parse(str_field(step, "status").unwrap_or_default()),
                    })
                    .collect();
                let id = format!("plan-{turn}");
                self.last.insert(thread.to_owned(), Last::Other);
                vec![
                    AgentEvent::ToolCall {
                        id: id.clone(),
                        call: ToolCall::Todo { items },
                    },
                    AgentEvent::ToolResult {
                        id,
                        is_error: false,
                        output: None,
                    },
                ]
            }
            "thread/tokenUsage/updated" if main => {
                let usage = &params["tokenUsage"];
                vec![AgentEvent::ContextUsage {
                    tokens: usage["last"]["totalTokens"].as_u64(),
                    window: usage["modelContextWindow"].as_u64(),
                }]
            }
            "error" if main => {
                if params["willRetry"].as_bool() != Some(true) {
                    self.last_error = str_field(&params["error"], "message").map(str::to_owned);
                }
                Vec::new()
            }
            _ => Vec::new(),
        }
    }

    fn text(&mut self, thread: &str, item: &str, delta: &str) -> Option<AgentEvent> {
        if delta.is_empty() {
            return None;
        }
        self.streamed.insert(item.to_owned());
        let last = self.last.insert(thread.to_owned(), Last::Text(item.to_owned()));
        let gap = matches!(&last, Some(Last::Text(prev)) if prev != item);
        Some(AgentEvent::TextDelta {
            text: if gap { format!("\n\n{delta}") } else { delta.to_owned() },
        })
    }

    fn reasoning(&mut self, thread: &str, item: &str, index: i64, delta: &str) -> Option<AgentEvent> {
        if delta.is_empty() {
            return None;
        }
        self.streamed.insert(item.to_owned());
        let key = Last::Reasoning(item.to_owned(), index);
        let last = self.last.insert(thread.to_owned(), key.clone());
        let gap = matches!(&last, Some(prev @ Last::Reasoning(..)) if *prev != key);
        Some(AgentEvent::ReasoningDelta {
            text: if gap { format!("\n\n{delta}") } else { delta.to_owned() },
        })
    }

    fn item(&mut self, item: &Value, thread: &str, main: bool, completed: bool) -> Vec<AgentEvent> {
        let id = str_field(item, "id").unwrap_or_default().to_owned();
        let kind = str_field(item, "type").unwrap_or_default();
        match kind {
            "agentMessage" => {
                if !completed || self.streamed.contains(&id) {
                    return Vec::new();
                }
                let text = str_field(item, "text").unwrap_or_default().to_owned();
                self.text(thread, &id, &text).into_iter().collect()
            }
            "plan" => {
                if completed && main {
                    // The whole plan, whatever its deltas said.
                    self.plan = str_field(item, "text").unwrap_or_default().to_owned();
                }
                Vec::new()
            }
            // `/review`'s findings arrive whole as it leaves review mode.
            "exitedReviewMode" if completed => {
                let review = str_field(item, "review").unwrap_or_default().to_owned();
                self.text(thread, &id, &review).into_iter().collect()
            }
            "contextCompaction" if main => vec![AgentEvent::Compaction {
                status: if completed {
                    CompactionStatus::Completed
                } else {
                    CompactionStatus::Running
                },
                auto: !self.compact_turn,
                before_tokens: None,
                after_tokens: None,
                error: None,
            }],
            "reasoning" => {
                if !completed || self.streamed.contains(&id) {
                    return Vec::new();
                }
                let summary: Vec<&str> = item["summary"]
                    .as_array()
                    .map(Vec::as_slice)
                    .unwrap_or_default()
                    .iter()
                    .filter_map(Value::as_str)
                    .collect();
                self.reasoning(thread, &id, 0, &summary.join("\n\n")).into_iter().collect()
            }
            _ => {
                if main && kind == "collabAgentToolCall" && str_field(item, "tool") == Some("spawnAgent") {
                    for child in item["receiverThreadIds"].as_array().into_iter().flatten() {
                        if let Some(child) = child.as_str() {
                            self.children.insert(child.to_owned(), id.clone());
                        }
                    }
                }
                let calls = self.tool_calls(item);
                if calls.is_empty() {
                    return Vec::new();
                }
                self.last.insert(thread.to_owned(), Last::Other);
                let mut events = Vec::new();
                for (call_id, call) in calls {
                    if self.calls.get(&call_id) != Some(&call) {
                        self.calls.insert(call_id.clone(), call.clone());
                        events.push(AgentEvent::ToolCall {
                            id: call_id.clone(),
                            call,
                        });
                    }
                    if completed {
                        let (is_error, output) = outcome(item);
                        events.push(AgentEvent::ToolResult {
                            id: call_id,
                            is_error,
                            output,
                        });
                    }
                }
                events
            }
        }
    }

    /// The calls an item shows as: one per changed file for a file change,
    /// else one; none for items that aren't tool calls.
    fn tool_calls(&mut self, item: &Value) -> Vec<(String, ToolCall)> {
        let id = str_field(item, "id").unwrap_or_default().to_owned();
        let one = |call| vec![(id.clone(), call)];
        match str_field(item, "type").unwrap_or_default() {
            "commandExecution" => one(command_call(item)),
            "fileChange" => {
                let changes = item["changes"].as_array().map(Vec::as_slice).unwrap_or_default();
                self.paths.insert(
                    id.clone(),
                    changes
                        .iter()
                        .filter_map(|c| str_field(c, "path").map(str::to_owned))
                        .collect(),
                );
                changes
                    .iter()
                    .enumerate()
                    .map(|(i, change)| {
                        let call_id = if changes.len() == 1 { id.clone() } else { format!("{id}:{i}") };
                        (call_id, file_change(change))
                    })
                    .collect()
            }
            "mcpToolCall" => one(ToolCall::Mcp {
                server: str_field(item, "server").unwrap_or_default().to_owned(),
                tool: str_field(item, "tool").unwrap_or_default().to_owned(),
                input: present(&item["arguments"]),
            }),
            "dynamicToolCall" => one(ToolCall::Unknown {
                name: str_field(item, "tool").unwrap_or("tool").to_owned(),
                input: present(&item["arguments"]),
            }),
            "collabAgentToolCall" => {
                let prompt = str_field(item, "prompt").map(str::to_owned);
                one(match str_field(item, "tool") {
                    Some("spawnAgent") => ToolCall::Subagent {
                        description: prompt
                            .as_deref()
                            .and_then(|p| p.lines().find(|l| !l.trim().is_empty()))
                            .unwrap_or("Subagent")
                            .trim()
                            .to_owned(),
                        model: str_field(item, "model").map(str::to_owned),
                        prompt: prompt.clone(),
                        agent: None,
                    },
                    tool => ToolCall::Unknown {
                        name: agent_tool_label(tool.unwrap_or_default()).to_owned(),
                        input: prompt.map(Value::String),
                    },
                })
            }
            "webSearch" => {
                let action = &item["action"];
                one(match str_field(action, "type") {
                    Some("openPage" | "findInPage") => ToolCall::WebFetch {
                        url: str_field(action, "url").unwrap_or_default().to_owned(),
                        prompt: str_field(action, "pattern").map(str::to_owned),
                    },
                    _ => ToolCall::WebSearch {
                        query: str_field(item, "query")
                            .filter(|q| !q.is_empty())
                            .or_else(|| str_field(action, "query"))
                            .unwrap_or_default()
                            .to_owned(),
                    },
                })
            }
            "imageView" => one(ToolCall::ReadFile {
                path: str_field(item, "path").unwrap_or_default().to_owned(),
            }),
            _ => Vec::new(),
        }
    }
}

/// How a turn ended, by its `status`.
pub(super) fn turn_status(turn: &Value) -> DoneStatus {
    match str_field(turn, "status") {
        Some("failed") => DoneStatus::Errored,
        Some("interrupted") => DoneStatus::Interrupted,
        _ => DoneStatus::Completed,
    }
}

fn str_field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn present(value: &Value) -> Option<Value> {
    (!value.is_null()).then(|| value.clone())
}

fn agent_tool_label(tool: &str) -> &str {
    match tool {
        "sendInput" | "sendMessage" => "Message agent",
        "resumeAgent" => "Resume agent",
        "wait" => "Wait for agents",
        "closeAgent" => "Close agent",
        "followupTask" => "Follow-up task",
        "interruptAgent" => "Interrupt agent",
        "listAgents" => "List agents",
        other => other,
    }
}

/// Whether a finished item failed, and what it printed.
fn outcome(item: &Value) -> (bool, Option<String>) {
    let status = str_field(item, "status").unwrap_or_default();
    let declined = status == "declined";
    let failed = matches!(status, "failed" | "declined");
    match str_field(item, "type").unwrap_or_default() {
        "commandExecution" => {
            let exit = item["exitCode"].as_i64();
            let output = str_field(item, "aggregatedOutput")
                .filter(|o| !o.is_empty())
                .map(str::to_owned)
                .or_else(|| declined.then(|| "The user declined this command.".to_owned()));
            (failed || exit.is_some_and(|c| c != 0), output)
        }
        "fileChange" => (failed, declined.then(|| "The user declined this change.".to_owned())),
        "mcpToolCall" => {
            if let Some(message) = str_field(&item["error"], "message") {
                return (true, Some(message.to_owned()));
            }
            (failed, content_text(&item["result"]["content"]))
        }
        "dynamicToolCall" => (
            failed || item["success"].as_bool() == Some(false),
            content_text(&item["contentItems"]),
        ),
        _ => (failed, None),
    }
}

/// The text blocks of an MCP-style content list.
fn content_text(content: &Value) -> Option<String> {
    let texts: Vec<&str> = content.as_array()?.iter().filter_map(|c| str_field(c, "text")).collect();
    (!texts.is_empty()).then(|| texts.join("\n"))
}

/// A command item as a call. A lone read or search the CLI recognized
/// shows as one; else the command, out of its shell wrapper.
pub(super) fn command_call(item: &Value) -> ToolCall {
    let raw = str_field(item, "command").unwrap_or_default();
    let actions = item["commandActions"].as_array().map(Vec::as_slice).unwrap_or_default();
    let shown = match actions {
        [action] => str_field(action, "command")
            .filter(|c| !c.is_empty())
            .map_or_else(|| unwrap_shell(raw), str::to_owned),
        _ => unwrap_shell(raw),
    };
    let exec = || ToolCall::Exec { command: shown.clone() };
    match actions {
        [action] => match str_field(action, "type") {
            Some("read") => match str_field(action, "path") {
                Some(path) if !path.is_empty() => ToolCall::ReadFile { path: path.to_owned() },
                _ => exec(),
            },
            Some("search") => match str_field(action, "query") {
                Some(query) if !query.is_empty() => ToolCall::Search {
                    pattern: query.to_owned(),
                    path: str_field(action, "path").map(str::to_owned),
                },
                _ => exec(),
            },
            _ => exec(),
        },
        _ => exec(),
    }
}

/// `"…\pwsh.exe" -Command 'dir'` or `/bin/bash -lc 'ls'` → the script
/// inside; anything else as is.
pub(super) fn unwrap_shell(command: &str) -> String {
    let lower = command.to_ascii_lowercase();
    for flag in [" -command ", " -lc ", " -c "] {
        let Some(at) = lower.find(flag) else {
            continue;
        };
        let shell = lower[..at].trim_end_matches(['"', '\'']).trim_end_matches(".exe");
        if !["pwsh", "powershell", "bash", "zsh", "sh", "cmd"].iter().any(|s| shell.ends_with(s)) {
            continue;
        }
        let script = command[at + flag.len()..].trim();
        for quote in ['\'', '"'] {
            if script.len() >= 2 && script.starts_with(quote) && script.ends_with(quote) {
                let inner = &script[1..script.len() - 1];
                return inner.replace(&format!("{quote}{quote}"), &quote.to_string());
            }
        }
        return script.to_owned();
    }
    command.to_owned()
}

/// One changed file: a new file with its content, an edit with the lines
/// its hunks touch, a deletion as an edit that removes what it held.
fn file_change(change: &Value) -> ToolCall {
    let path = str_field(change, "path").unwrap_or_default().to_owned();
    let diff = str_field(change, "diff").unwrap_or_default();
    let kind = &change["kind"];
    match str_field(kind, "type") {
        Some("add") => ToolCall::WriteFile {
            path,
            content: Some(side(diff, '+')),
        },
        Some("delete") => ToolCall::EditFile {
            path,
            old_string: Some(side(diff, '-')),
            new_string: Some(String::new()),
        },
        _ => {
            let (old, new) = hunks(diff);
            ToolCall::EditFile {
                path: str_field(kind, "move_path").map_or(path, str::to_owned),
                old_string: Some(old),
                new_string: Some(new),
            }
        }
    }
}

/// A whole-file diff's one side: its `sign` lines, or the text itself when
/// it isn't a diff.
fn side(diff: &str, sign: char) -> String {
    if !diff.starts_with("@@") && !diff.starts_with("---") {
        return diff.to_owned();
    }
    let (old, new) = hunks(diff);
    if sign == '+' { new } else { old }
}

/// Before and after of a unified diff's hunks, context in both; hunks
/// separated by an elision line.
fn hunks(diff: &str) -> (String, String) {
    let mut old = Vec::new();
    let mut new = Vec::new();
    let mut hunk = 0;
    for line in diff.lines() {
        if line.starts_with("---") || line.starts_with("+++") || line.starts_with('\\') {
            continue;
        }
        if line.starts_with("@@") {
            hunk += 1;
            if hunk > 1 {
                old.push("…");
                new.push("…");
            }
            continue;
        }
        match line.split_at(line.len().min(1)) {
            ("-", rest) => old.push(rest),
            ("+", rest) => new.push(rest),
            (" ", rest) => {
                old.push(rest);
                new.push(rest);
            }
            _ => {
                old.push(line);
                new.push(line);
            }
        }
    }
    let join = |lines: Vec<&str>| if lines.is_empty() { String::new() } else { lines.join("\n") + "\n" };
    (join(old), join(new))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn normalizer() -> Normalizer {
        Normalizer::new("T".into())
    }

    #[test]
    fn unwraps_the_shell() {
        assert_eq!(
            unwrap_shell(r#""C:\\Program Files\\PowerShell\\pwsh.exe" -Command 'git --version'"#),
            "git --version"
        );
        assert_eq!(unwrap_shell("/bin/bash -lc 'ls -la'"), "ls -la");
        assert_eq!(unwrap_shell("pwsh -Command 'echo ''hi'''"), "echo 'hi'");
        assert_eq!(unwrap_shell("cargo test"), "cargo test");
    }

    #[test]
    fn separates_text_items_and_skips_repeats() {
        let mut n = normalizer();
        let delta = |item: &str, d: &str| json!({"threadId": "T", "itemId": item, "delta": d});
        let a = n.notification("item/agentMessage/delta", &delta("a", "Hi"));
        let b = n.notification("item/agentMessage/delta", &delta("b", "There"));
        assert_eq!(a, [AgentEvent::TextDelta { text: "Hi".into() }]);
        assert_eq!(b, [AgentEvent::TextDelta { text: "\n\nThere".into() }]);
        let done = |id: &str, text: &str| json!({"threadId": "T", "item": {"type": "agentMessage", "id": id, "text": text}});
        assert!(n.notification("item/completed", &done("b", "There")).is_empty());
        assert_eq!(
            n.notification("item/completed", &done("c", "Whole")),
            [AgentEvent::TextDelta { text: "\n\nWhole".into() }]
        );
    }

    #[test]
    fn plans_are_kept_not_shown() {
        let mut n = normalizer();
        let delta = json!({"threadId": "T", "itemId": "p", "delta": "1. Do"});
        assert!(n.notification("item/plan/delta", &delta).is_empty());
        assert_eq!(n.plan, "1. Do");
        let done = json!({"threadId": "T", "item": {"type": "plan", "id": "p", "text": "1. Do it"}});
        assert!(n.notification("item/completed", &done).is_empty());
        assert_eq!(n.plan, "1. Do it");
        n.start_turn();
        assert!(n.plan.is_empty());
    }

    #[test]
    fn commands_become_calls_with_results() {
        let mut n = normalizer();
        let item = json!({
            "type": "commandExecution", "id": "x1",
            "command": "\"C:\\\\pwsh.exe\" -Command 'Get-Content -LiteralPath a.txt'",
            "status": "inProgress",
            "commandActions": [{"type": "read", "command": "Get-Content -LiteralPath a.txt", "name": "a.txt", "path": "C:\\w\\a.txt"}],
        });
        let started = n.notification("item/started", &json!({"threadId": "T", "item": item}));
        let read = ToolCall::ReadFile { path: "C:\\w\\a.txt".into() };
        assert_eq!(started, [AgentEvent::ToolCall { id: "x1".into(), call: read.clone() }]);
        assert_eq!(n.call("x1"), Some(&read));

        let mut done = item.clone();
        done["status"] = json!("completed");
        done["exitCode"] = json!(1);
        done["aggregatedOutput"] = json!("boom");
        let events = n.notification("item/completed", &json!({"threadId": "T", "item": done}));
        assert_eq!(
            events,
            [AgentEvent::ToolResult {
                id: "x1".into(),
                is_error: true,
                output: Some("boom".into()),
            }]
        );
    }

    #[test]
    fn file_changes_carry_their_lines() {
        let mut n = normalizer();
        let item = json!({"type": "fileChange", "id": "f", "status": "completed", "changes": [
            {"path": "/w/a.txt", "kind": {"type": "update", "move_path": null}, "diff": "@@ -1 +1 @@\n-hello\n+hello world\n"},
            {"path": "/w/b.txt", "kind": {"type": "add"}, "diff": "bee\n"},
            {"path": "/w/c.txt", "kind": {"type": "delete"}, "diff": "gone\n"},
        ]});
        let events = n.notification("item/completed", &json!({"threadId": "T", "item": item}));
        assert_eq!(
            events[0],
            AgentEvent::ToolCall {
                id: "f:0".into(),
                call: ToolCall::EditFile {
                    path: "/w/a.txt".into(),
                    old_string: Some("hello\n".into()),
                    new_string: Some("hello world\n".into()),
                }
            }
        );
        assert_eq!(
            events[2],
            AgentEvent::ToolCall {
                id: "f:1".into(),
                call: ToolCall::WriteFile {
                    path: "/w/b.txt".into(),
                    content: Some("bee\n".into())
                }
            }
        );
        assert!(matches!(
            &events[4],
            AgentEvent::ToolCall { call: ToolCall::EditFile { old_string: Some(old), new_string: Some(new), .. }, .. }
                if old == "gone\n" && new.is_empty()
        ));
        assert_eq!(n.paths("f"), ["/w/a.txt", "/w/b.txt", "/w/c.txt"]);
        assert!(matches!(n.call("f"), Some(ToolCall::EditFile { .. })));
    }

    #[test]
    fn todo_lists_and_usage() {
        let mut n = normalizer();
        let events = n.notification(
            "turn/plan/updated",
            &json!({"threadId": "T", "turnId": "u", "plan": [
                {"step": "One", "status": "completed"}, {"step": "Two", "status": "inProgress"}
            ]}),
        );
        assert!(matches!(&events[0], AgentEvent::ToolCall { id, call: ToolCall::Todo { items } }
            if id == "plan-u" && items[1].status == TodoStatus::InProgress));
        let usage = n.notification(
            "thread/tokenUsage/updated",
            &json!({"threadId": "T", "turnId": "u", "tokenUsage": {"last": {"totalTokens": 120}, "total": {}, "modelContextWindow": 1000}}),
        );
        assert_eq!(
            usage,
            [AgentEvent::ContextUsage {
                tokens: Some(120),
                window: Some(1000)
            }]
        );
    }

    #[test]
    fn subagent_threads_are_wrapped() {
        let mut n = normalizer();
        let spawn = json!({"threadId": "T", "item": {
            "type": "collabAgentToolCall", "id": "s", "tool": "spawnAgent", "status": "inProgress",
            "senderThreadId": "T", "receiverThreadIds": ["C"], "prompt": "Look around\nmore", "model": null
        }});
        let events = n.notification("item/started", &spawn);
        assert!(matches!(&events[0], AgentEvent::ToolCall { call: ToolCall::Subagent { description, .. }, .. }
            if description == "Look around"));
        let child = n.notification("item/agentMessage/delta", &json!({"threadId": "C", "itemId": "m", "delta": "hi"}));
        assert_eq!(
            child,
            [AgentEvent::Subagent {
                parent_tool_id: "s".into(),
                event: Box::new(AgentEvent::TextDelta { text: "hi".into() })
            }]
        );
        let done = n.notification("turn/completed", &json!({"threadId": "C", "turn": {"status": "completed"}}));
        assert!(matches!(&done[0], AgentEvent::Subagent { event, .. } if matches!(**event, AgentEvent::Done { .. })));
        assert!(
            n.notification("item/agentMessage/delta", &json!({"threadId": "Z", "itemId": "m", "delta": "x"}))
                .is_empty()
        );
    }
}
