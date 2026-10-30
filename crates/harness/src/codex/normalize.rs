//! App-server notifications → [`AgentEvent`]s.
//!
//! Turn lifecycle (`turn/started`, `turn/completed` on the main thread) is
//! the session's business; this turns items and deltas into transcript
//! events. A subagent's thread is followed once its spawn call names it, and
//! its events come out wrapped in [`AgentEvent::Subagent`].

use std::collections::{HashMap, HashSet};

use hive_proto::{
    AgentEvent, CompactionStatus, DoneStatus, TodoItem, TodoStatus, ToolCall, ToolDiff,
};
use serde_json::Value;

#[derive(Default)]
pub struct Normalizer {
    /// The run's own thread.
    pub thread_id: Option<String>,
    /// Subagent threads → the spawn call's id.
    children: HashMap<String, String>,
    /// What each thread streamed last, for separating text blocks.
    last: HashMap<String, Last>,
    /// Text items whose deltas came: their completion repeats nothing.
    streamed: HashSet<String>,
    /// A command item's command as shown, for its approval question.
    commands: HashMap<String, String>,
    /// A file change item's paths, for its approval question.
    paths: HashMap<String, Vec<String>>,
    /// Each call as last reported, so a completion repeats only what changed.
    calls: HashMap<String, ToolCall>,
    /// The turn produced a plan (plan mode).
    pub plan_seen: bool,
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
    pub fn new(thread_id: String) -> Self {
        Self {
            thread_id: Some(thread_id),
            ..Self::default()
        }
    }

    /// The command an item runs, as an approval question shows it.
    pub fn command(&self, item_id: &str) -> Option<&str> {
        self.commands.get(item_id).map(String::as_str)
    }

    /// The files an item changes.
    pub fn paths(&self, item_id: &str) -> &[String] {
        self.paths
            .get(item_id)
            .map(Vec::as_slice)
            .unwrap_or_default()
    }

    /// Clears per-turn state.
    pub fn start_turn(&mut self) {
        self.plan_seen = false;
        self.compact_turn = false;
        self.last_error = None;
        self.streamed.clear();
        if let Some(thread) = &self.thread_id {
            self.last.remove(thread);
        }
    }

    pub fn notification(&mut self, method: &str, params: &Value) -> Vec<AgentEvent> {
        let thread = str_field(params, "threadId").unwrap_or_default().to_owned();
        let main = self.thread_id.as_deref() == Some(thread.as_str()) || thread.is_empty();
        if main {
            return self.events(method, params, &thread, true);
        }
        let Some(parent) = self.children.get(&thread).cloned() else {
            return Vec::new(); // Some other thread's traffic.
        };
        let events = if method == "turn/completed" {
            let turn = &params["turn"];
            vec![AgentEvent::Done {
                status: match str_field(turn, "status") {
                    Some("failed") => DoneStatus::Errored,
                    Some("interrupted") => DoneStatus::Interrupted,
                    _ => DoneStatus::Completed,
                },
                error: None,
                session_id: None,
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

    fn events(
        &mut self,
        method: &str,
        params: &Value,
        thread: &str,
        main: bool,
    ) -> Vec<AgentEvent> {
        let item_id = str_field(params, "itemId").unwrap_or_default();
        let delta = str_field(params, "delta").unwrap_or_default();
        match method {
            "item/agentMessage/delta" | "item/plan/delta" => {
                if method == "item/plan/delta" {
                    self.plan_seen = true;
                }
                self.text(thread, item_id, delta).into_iter().collect()
            }
            "item/reasoning/summaryTextDelta" => {
                let index = params["summaryIndex"].as_i64().unwrap_or(0);
                self.reasoning(thread, item_id, index, delta)
                    .into_iter()
                    .collect()
            }
            "item/reasoning/textDelta" => {
                let index = params["contentIndex"].as_i64().unwrap_or(0);
                self.reasoning(thread, item_id, index, delta)
                    .into_iter()
                    .collect()
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
                        diff: None,
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
        let last = self
            .last
            .insert(thread.to_owned(), Last::Text(item.to_owned()));
        let gap = matches!(&last, Some(Last::Text(prev)) if prev != item);
        Some(AgentEvent::TextDelta {
            text: if gap {
                format!("\n\n{delta}")
            } else {
                delta.to_owned()
            },
        })
    }

    fn reasoning(
        &mut self,
        thread: &str,
        item: &str,
        index: i64,
        delta: &str,
    ) -> Option<AgentEvent> {
        if delta.is_empty() {
            return None;
        }
        self.streamed.insert(item.to_owned());
        let key = Last::Reasoning(item.to_owned(), index);
        let last = self.last.insert(thread.to_owned(), key.clone());
        let gap = matches!(&last, Some(prev @ Last::Reasoning(..)) if *prev != key);
        Some(AgentEvent::ReasoningDelta {
            text: if gap {
                format!("\n\n{delta}")
            } else {
                delta.to_owned()
            },
        })
    }

    fn item(&mut self, item: &Value, thread: &str, main: bool, completed: bool) -> Vec<AgentEvent> {
        let id = str_field(item, "id").unwrap_or_default().to_owned();
        let kind = str_field(item, "type").unwrap_or_default();
        match kind {
            "agentMessage" | "plan" => {
                if kind == "plan" {
                    self.plan_seen = true;
                }
                if !completed || self.streamed.contains(&id) {
                    return Vec::new();
                }
                let text = str_field(item, "text").unwrap_or_default().to_owned();
                self.text(thread, &id, &text).into_iter().collect()
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
                self.reasoning(thread, &id, 0, &summary.join("\n\n"))
                    .into_iter()
                    .collect()
            }
            _ => {
                if main
                    && kind == "collabAgentToolCall"
                    && str_field(item, "tool") == Some("spawnAgent")
                {
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
                for (call_id, call, diff) in calls {
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
                            diff,
                        });
                    }
                }
                events
            }
        }
    }

    /// The calls an item shows as: one per changed file for a file change,
    /// else one; none for items that aren't tool calls.
    fn tool_calls(&mut self, item: &Value) -> Vec<(String, ToolCall, Option<ToolDiff>)> {
        let id = str_field(item, "id").unwrap_or_default().to_owned();
        let one = |call| vec![(id.clone(), call, None)];
        match str_field(item, "type").unwrap_or_default() {
            "commandExecution" => {
                let (call, shown) = command_call(item);
                self.commands.insert(id.clone(), shown);
                one(call)
            }
            "fileChange" => {
                let changes = item["changes"]
                    .as_array()
                    .map(Vec::as_slice)
                    .unwrap_or_default();
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
                        let call_id = if changes.len() == 1 {
                            id.clone()
                        } else {
                            format!("{id}:{i}")
                        };
                        let (call, diff) = file_change(change);
                        (call_id, call, diff)
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
                    Some("openPage") | Some("findInPage") => ToolCall::WebFetch {
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
        "fileChange" => (
            failed,
            declined.then(|| "The user declined this change.".to_owned()),
        ),
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
    let texts: Vec<&str> = content
        .as_array()?
        .iter()
        .filter_map(|c| str_field(c, "text"))
        .collect();
    (!texts.is_empty()).then(|| texts.join("\n"))
}

/// A command item as a call, and the command as an approval shows it. A
/// lone read or search the CLI recognized shows as one.
fn command_call(item: &Value) -> (ToolCall, String) {
    let raw = str_field(item, "command").unwrap_or_default();
    let actions = item["commandActions"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default();
    let shown = match actions {
        [action] => str_field(action, "command")
            .filter(|c| !c.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| unwrap_shell(raw)),
        _ => unwrap_shell(raw),
    };
    let call = match actions {
        [action] => match str_field(action, "type") {
            Some("read") if str_field(action, "path").is_some() => ToolCall::ReadFile {
                path: str_field(action, "path").unwrap_or_default().to_owned(),
            },
            Some("search") => match str_field(action, "query") {
                Some(query) if !query.is_empty() => ToolCall::Search {
                    pattern: query.to_owned(),
                    path: str_field(action, "path").map(str::to_owned),
                },
                _ => ToolCall::Exec {
                    command: shown.clone(),
                },
            },
            _ => ToolCall::Exec {
                command: shown.clone(),
            },
        },
        _ => ToolCall::Exec {
            command: shown.clone(),
        },
    };
    (call, shown)
}

/// `"…\pwsh.exe" -Command 'dir'` or `/bin/bash -lc 'ls'` → the script
/// inside; anything else as is.
fn unwrap_shell(command: &str) -> String {
    let lower = command.to_ascii_lowercase();
    for flag in [" -command ", " -lc ", " -c "] {
        let Some(at) = lower.find(flag) else {
            continue;
        };
        let shell = &lower[..at];
        if !["pwsh", "powershell", "bash", "zsh", "sh", "cmd"]
            .iter()
            .any(|s| {
                shell
                    .trim_end_matches(['"', '\''])
                    .trim_end_matches(".exe")
                    .ends_with(s)
            })
        {
            continue;
        }
        let script = command[at + flag.len()..].trim();
        for quote in ['\'', '"'] {
            if script.len() >= 2 && script.starts_with(quote) && script.ends_with(quote) {
                let inner = &script[1..script.len() - 1];
                let doubled = format!("{quote}{quote}");
                return inner.replace(&doubled, &quote.to_string());
            }
        }
        return script.to_owned();
    }
    command.to_owned()
}

/// One changed file: a new file with its content, an edit with the lines
/// its hunks touch, a deletion with what it removed.
fn file_change(change: &Value) -> (ToolCall, Option<ToolDiff>) {
    let path = str_field(change, "path").unwrap_or_default().to_owned();
    let diff = str_field(change, "diff").unwrap_or_default();
    let kind = &change["kind"];
    match str_field(kind, "type") {
        Some("add") => (
            ToolCall::WriteFile {
                path,
                content: Some(side(diff, '+')),
            },
            None,
        ),
        Some("delete") => (
            ToolCall::ApplyPatch {
                path: Some(path.clone()),
            },
            Some(ToolDiff {
                path,
                old_text: Some(side(diff, '-')),
                new_text: String::new(),
            }),
        ),
        _ => {
            let (old, new) = hunks(diff);
            let path = str_field(kind, "move_path")
                .map(str::to_owned)
                .unwrap_or(path);
            (
                ToolCall::EditFile {
                    path,
                    old_string: Some(old),
                    new_string: Some(new),
                },
                None,
            )
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
    if sign == '+' {
        new
    } else {
        old
    }
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
    let join = |lines: Vec<&str>| {
        if lines.is_empty() {
            String::new()
        } else {
            lines.join("\n") + "\n"
        }
    };
    (join(old), join(new))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn normalizer() -> Normalizer {
        Normalizer {
            thread_id: Some("T".into()),
            ..Default::default()
        }
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
        assert_eq!(a, vec![AgentEvent::TextDelta { text: "Hi".into() }]);
        assert_eq!(
            b,
            vec![AgentEvent::TextDelta {
                text: "\n\nThere".into()
            }]
        );
        // A completion after its deltas adds nothing; one without them adds its text.
        let done = |id: &str, text: &str| json!({"threadId": "T", "item": {"type": "agentMessage", "id": id, "text": text}});
        assert!(n
            .notification("item/completed", &done("b", "There"))
            .is_empty());
        assert_eq!(
            n.notification("item/completed", &done("c", "Whole")),
            vec![AgentEvent::TextDelta {
                text: "\n\nWhole".into()
            }]
        );
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
        assert_eq!(
            started,
            vec![AgentEvent::ToolCall {
                id: "x1".into(),
                call: ToolCall::ReadFile {
                    path: "C:\\w\\a.txt".into()
                }
            }]
        );
        assert_eq!(n.command("x1"), Some("Get-Content -LiteralPath a.txt"));

        let mut done = item.clone();
        done["status"] = json!("completed");
        done["exitCode"] = json!(1);
        done["aggregatedOutput"] = json!("boom");
        let events = n.notification("item/completed", &json!({"threadId": "T", "item": done}));
        assert_eq!(
            events[0],
            AgentEvent::ToolResult {
                id: "x1".into(),
                is_error: true,
                output: Some("boom".into()),
                diff: None
            }
        );
    }

    #[test]
    fn file_changes_carry_their_lines() {
        let mut n = normalizer();
        let item = json!({"type": "fileChange", "id": "f", "status": "completed", "changes": [
            {"path": "/w/a.txt", "kind": {"type": "update", "move_path": null}, "diff": "@@ -1 +1 @@\n-hello\n+hello world\n"},
            {"path": "/w/b.txt", "kind": {"type": "add"}, "diff": "bee\n"},
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
        assert_eq!(n.paths("f"), ["/w/a.txt", "/w/b.txt"]);
    }

    #[test]
    fn plans_and_usage() {
        let mut n = normalizer();
        let events = n.notification(
            "turn/plan/updated",
            &json!({"threadId": "T", "turnId": "u", "plan": [
                {"step": "One", "status": "completed"}, {"step": "Two", "status": "inProgress"}
            ]}),
        );
        assert!(
            matches!(&events[0], AgentEvent::ToolCall { id, call: ToolCall::Todo { items } }
            if id == "plan-u" && items[1].status == TodoStatus::InProgress)
        );
        let usage = n.notification(
            "thread/tokenUsage/updated",
            &json!({"threadId": "T", "tokenUsage": {"last": {"totalTokens": 120}, "total": {}, "modelContextWindow": 1000}}),
        );
        assert_eq!(
            usage,
            vec![AgentEvent::ContextUsage {
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
            "receiverThreadIds": ["C"], "prompt": "Look around\nmore", "model": null
        }});
        let events = n.notification("item/started", &spawn);
        assert!(
            matches!(&events[0], AgentEvent::ToolCall { call: ToolCall::Subagent { description, .. }, .. }
            if description == "Look around")
        );
        let child = n.notification(
            "item/agentMessage/delta",
            &json!({"threadId": "C", "itemId": "m", "delta": "hi"}),
        );
        assert_eq!(
            child,
            vec![AgentEvent::Subagent {
                parent_tool_id: "s".into(),
                event: Box::new(AgentEvent::TextDelta { text: "hi".into() })
            }]
        );
        let done = n.notification(
            "turn/completed",
            &json!({"threadId": "C", "turn": {"status": "completed"}}),
        );
        assert!(
            matches!(&done[0], AgentEvent::Subagent { event, .. } if matches!(**event, AgentEvent::Done { .. }))
        );
        assert!(n
            .notification(
                "item/agentMessage/delta",
                &json!({"threadId": "Z", "itemId": "m", "delta": "x"})
            )
            .is_empty());
    }
}
