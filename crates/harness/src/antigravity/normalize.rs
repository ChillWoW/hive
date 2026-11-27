//! `session/update` notifications as [`AgentEvent`]s: message and thought
//! chunks as text and reasoning, tool calls by their ACP `kind` and agy's own
//! input fields, `plan` as a todo list, `usage_update` as context occupancy,
//! `available_commands_update` as the session's commands.

use std::collections::{HashMap, HashSet};

use outcode_proto::{AgentEvent, CommandKind, SlashCommand, TodoItem, TodoStatus, ToolCall};
use serde_json::Value;

/// How much of a tool's output is kept.
const OUTPUT_LIMIT: usize = 16 * 1024;

/// agy's own commands; everything else it lists is a skill.
const BUILTIN_COMMANDS: &[&str] = &["goal", "compact", "schedule", "browser", "plan"];

/// Follows one session's updates across turns.
#[derive(Default)]
pub(super) struct Normalizer {
    /// Each tool call's last decoded form, by id.
    calls: HashMap<String, ToolCall>,
    /// Calls that already reported their result.
    finished: HashSet<String>,
    /// Counts plans, so each turn's todo list is its own call.
    plans: u64,
    plan_open: bool,
}

impl Normalizer {
    pub(super) fn start_turn(&mut self) {
        self.plan_open = false;
    }

    /// The call `id` as last decoded.
    pub(super) fn call(&self, id: &str) -> Option<&ToolCall> {
        self.calls.get(id)
    }

    /// One `session/update`'s `update`.
    pub(super) fn update(&mut self, update: &Value) -> Vec<AgentEvent> {
        match update["sessionUpdate"].as_str().unwrap_or_default() {
            "agent_message_chunk" => text(&update["content"])
                .map(|text| AgentEvent::TextDelta { text })
                .into_iter()
                .collect(),
            "agent_thought_chunk" => text(&update["content"])
                .map(|text| AgentEvent::ReasoningDelta { text })
                .into_iter()
                .collect(),
            "tool_call" | "tool_call_update" => self.tool_call(update),
            "plan" => self.plan(update),
            "usage_update" => vec![AgentEvent::ContextUsage {
                tokens: update["used"].as_u64(),
                window: update["size"].as_u64().filter(|s| *s > 0),
            }],
            "available_commands_update" => vec![AgentEvent::AvailableCommands {
                commands: commands(&update["availableCommands"]),
            }],
            _ => Vec::new(),
        }
    }

    fn tool_call(&mut self, update: &Value) -> Vec<AgentEvent> {
        let Some(id) = update["toolCallId"].as_str().filter(|i| !i.is_empty()) else {
            return Vec::new();
        };
        let mut events = Vec::new();
        let call = decode(update, self.calls.get(id));
        if self.calls.get(id) != Some(&call) && !self.finished.contains(id) {
            self.calls.insert(id.to_owned(), call.clone());
            events.push(AgentEvent::ToolCall { id: id.to_owned(), call });
        }
        let status = update["status"].as_str().unwrap_or_default();
        if matches!(status, "completed" | "failed") && self.finished.insert(id.to_owned()) {
            events.push(AgentEvent::ToolResult {
                id: id.to_owned(),
                is_error: status == "failed",
                output: output(update),
            });
        }
        events
    }

    fn plan(&mut self, update: &Value) -> Vec<AgentEvent> {
        let items: Vec<TodoItem> = list(&update["entries"])
            .iter()
            .filter_map(|entry| {
                let text = entry["content"].as_str()?.trim();
                (!text.is_empty()).then(|| TodoItem {
                    text: text.to_owned(),
                    status: TodoStatus::parse(entry["status"].as_str().unwrap_or_default()),
                })
            })
            .collect();
        if !self.plan_open {
            self.plans += 1;
            self.plan_open = true;
        }
        vec![AgentEvent::ToolCall {
            id: format!("agy-plan-{}", self.plans),
            call: ToolCall::Todo { items },
        }]
    }
}

fn list(value: &Value) -> &[Value] {
    value.as_array().map(Vec::as_slice).unwrap_or_default()
}

/// A content block's text.
fn text(content: &Value) -> Option<String> {
    (content["type"].as_str() == Some("text"))
        .then(|| content["text"].as_str())
        .flatten()
        .filter(|t| !t.is_empty())
        .map(str::to_owned)
}

/// The first of `keys` in `input` that holds a non-empty string. agy names
/// its tools' fields in PascalCase; other forms are tried too.
fn field(input: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| input[*key].as_str().map(str::trim).filter(|s| !s.is_empty()))
        .map(str::to_owned)
}

const PATH_KEYS: &[&str] = &[
    "Path",
    "AbsolutePath",
    "TargetFile",
    "FilePath",
    "File",
    "path",
    "file_path",
    "filePath",
    "absolute_path",
];

/// A tool call's input: `rawInput`, else agy's `args`.
fn input(update: &Value) -> &Value {
    match &update["rawInput"] {
        Value::Object(map) if !map.is_empty() => &update["rawInput"],
        _ => &update["args"],
    }
}

/// The call's file, from its input or its locations.
fn path(update: &Value, input: &Value) -> Option<String> {
    field(input, PATH_KEYS).or_else(|| {
        list(&update["locations"])
            .first()
            .and_then(|l| l["path"].as_str())
            .map(str::to_owned)
    })
}

/// The tool call as the transcript renders it. An update may leave out what
/// the first report said, so the earlier decoding fills it in.
fn decode(update: &Value, earlier: Option<&ToolCall>) -> ToolCall {
    let input = input(update);
    let has_input = input.as_object().is_some_and(|m| !m.is_empty());
    if !has_input && let Some(earlier) = earlier {
        return earlier.clone();
    }
    let name = update["name"]
        .as_str()
        .or_else(|| update["title"].as_str())
        .unwrap_or("tool")
        .to_owned();
    let kind = update["kind"].as_str().unwrap_or_default();
    let diff = list(&update["content"]).iter().find(|c| c["type"].as_str() == Some("diff"));
    let raw = || has_input.then(|| input.clone());
    match (kind, name.as_str()) {
        ("execute", _) | (_, "run_command") => match field(input, &["CommandLine", "command", "Command", "cmd"]) {
            Some(command) => ToolCall::Exec { command },
            None => ToolCall::Unknown { name, input: raw() },
        },
        ("read", _) | (_, "read_file" | "view_file") => match path(update, input) {
            Some(path) => ToolCall::ReadFile { path },
            None => ToolCall::Unknown { name, input: raw() },
        },
        ("edit" | "delete" | "move", _) | (_, "write_file" | "edit_file") => {
            let Some(path) = path(update, input) else {
                return ToolCall::Unknown { name, input: raw() };
            };
            let new = field(input, &["Content", "CodeContent", "content"]);
            let old_text = diff.and_then(|d| d["oldText"].as_str()).filter(|t| !t.is_empty());
            if name == "write_file" || (old_text.is_none() && new.is_some()) {
                let content = new.or_else(|| diff.and_then(|d| d["newText"].as_str()).map(str::to_owned));
                return ToolCall::WriteFile { path, content };
            }
            ToolCall::EditFile {
                path,
                old_string: old_text
                    .map(str::to_owned)
                    .or_else(|| field(input, &["TargetContent", "OldString", "old_string"])),
                new_string: diff
                    .and_then(|d| d["newText"].as_str())
                    .map(str::to_owned)
                    .or_else(|| field(input, &["ReplacementContent", "NewString", "new_string"])),
            }
        }
        ("search", _) | (_, "grep_search" | "search_files" | "list_directory") => {
            match field(input, &["Query", "Pattern", "pattern", "query"]) {
                Some(pattern) => ToolCall::Search {
                    pattern,
                    path: field(input, &["SearchPath", "SearchDirectory", "DirectoryPath", "path"]),
                },
                None => match field(input, &["DirectoryPath", "SearchDirectory", "path"]) {
                    Some(dir) => ToolCall::Glob { pattern: dir },
                    None => ToolCall::Unknown { name, input: raw() },
                },
            }
        }
        (_, "web_search") => match field(input, &["Query", "query"]) {
            Some(query) => ToolCall::WebSearch { query },
            None => ToolCall::Unknown { name, input: raw() },
        },
        ("fetch", _) | (_, "read_url") => match field(input, &["Url", "url", "URL"]) {
            Some(url) => ToolCall::WebFetch { url, prompt: None },
            None => match field(input, &["Query", "query"]) {
                Some(query) => ToolCall::WebSearch { query },
                None => ToolCall::Unknown { name, input: raw() },
            },
        },
        (_, "invoke_subagent") => ToolCall::Subagent {
            description: field(input, &["TaskName", "Description", "Name", "description"])
                .or_else(|| update["title"].as_str().map(str::to_owned))
                .unwrap_or_else(|| "Subagent".into()),
            model: None,
            prompt: field(input, &["Prompt", "Task", "Instructions", "prompt"]),
            agent: field(input, &["Agent", "AgentName", "agent"]),
        },
        _ => {
            if let (Some(server), Some(tool)) = (field(input, &["ServerName"]), field(input, &["ToolName"])) {
                return ToolCall::Mcp {
                    server,
                    tool,
                    input: Some(input["Arguments"].clone()).filter(|a| !a.is_null()),
                };
            }
            ToolCall::Unknown { name, input: raw() }
        }
    }
}

/// What the call printed: its text content, else its raw output.
fn output(update: &Value) -> Option<String> {
    let mut out = String::new();
    for block in list(&update["content"]) {
        let text = match block["type"].as_str() {
            Some("content") => block["content"]["text"].as_str(),
            Some("text") => block["text"].as_str(),
            _ => None,
        };
        if let Some(text) = text {
            if !out.is_empty() {
                out.push('\n');
            }
            out.push_str(text);
        }
    }
    if out.trim().is_empty() {
        out = match &update["rawOutput"] {
            Value::String(s) => s.clone(),
            Value::Object(map) if !map.is_empty() => field(&update["rawOutput"], &["output", "Output", "combinedOutput", "combined_output", "error"])
                .unwrap_or_else(|| update["rawOutput"].to_string()),
            _ => String::new(),
        };
    }
    let out = out.trim();
    if out.is_empty() {
        return None;
    }
    if out.len() <= OUTPUT_LIMIT {
        return Some(out.to_owned());
    }
    let mut cut = out.len() - OUTPUT_LIMIT;
    while !out.is_char_boundary(cut) {
        cut += 1;
    }
    Some(format!("[Earlier output truncated]\n{}", &out[cut..]))
}

/// `available_commands_update`'s list.
fn commands(list_value: &Value) -> Vec<SlashCommand> {
    list(list_value)
        .iter()
        .filter_map(|c| {
            let name = c["name"].as_str()?.trim().trim_start_matches('/');
            (!name.is_empty()).then(|| SlashCommand {
                name: name.to_owned(),
                description: c["description"].as_str().unwrap_or_default().trim().to_owned(),
                input_hint: c["input"]["hint"]
                    .as_str()
                    .map(str::trim)
                    .filter(|h| !h.is_empty())
                    .map(str::to_owned),
                kind: if BUILTIN_COMMANDS.contains(&name) {
                    CommandKind::Command
                } else {
                    CommandKind::Skill
                },
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn chunks_become_text_and_reasoning() {
        let mut n = Normalizer::default();
        let text = json!({ "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": "Done." } });
        assert_eq!(n.update(&text), [AgentEvent::TextDelta { text: "Done.".into() }]);
        let thought = json!({ "sessionUpdate": "agent_thought_chunk", "content": { "type": "text", "text": "hm" } });
        assert_eq!(n.update(&thought), [AgentEvent::ReasoningDelta { text: "hm".into() }]);
        let usage = json!({ "sessionUpdate": "usage_update", "used": 10605, "size": 1048576 });
        assert_eq!(
            n.update(&usage),
            [AgentEvent::ContextUsage { tokens: Some(10605), window: Some(1048576) }]
        );
    }

    /// As agy 1.5.18 reports a read and a write.
    #[test]
    fn tool_calls_decode_and_finish_once() {
        let mut n = Normalizer::default();
        let read = json!({ "sessionUpdate": "tool_call", "toolCallId": "c1", "name": "read_file",
            "status": "in_progress", "kind": "read", "title": "File a.txt",
            "locations": [{ "path": "E:\\w\\a.txt" }], "rawInput": { "Path": "E:\\w\\a.txt" } });
        assert_eq!(
            n.update(&read),
            [AgentEvent::ToolCall { id: "c1".into(), call: ToolCall::ReadFile { path: "E:\\w\\a.txt".into() } }]
        );
        let mut done = read.clone();
        done["sessionUpdate"] = json!("tool_call_update");
        done["status"] = json!("completed");
        assert_eq!(
            n.update(&done),
            [AgentEvent::ToolResult { id: "c1".into(), is_error: false, output: None }]
        );
        assert!(n.update(&done).is_empty(), "a repeated end reports nothing");

        let write = json!({ "sessionUpdate": "tool_call_update", "toolCallId": "c2", "name": "write_file",
            "status": "completed", "kind": "edit", "rawInput": { "Content": "bye", "Path": "E:\\w\\b.txt" },
            "rawOutput": {}, "content": [{ "type": "diff", "path": "/E:/w/b.txt", "newText": "bye" }] });
        assert_eq!(
            n.update(&write)[0],
            AgentEvent::ToolCall {
                id: "c2".into(),
                call: ToolCall::WriteFile { path: "E:\\w\\b.txt".into(), content: Some("bye".into()) }
            }
        );

        let exec = json!({ "sessionUpdate": "tool_call", "toolCallId": "c3", "name": "run_command", "kind": "execute",
            "status": "in_progress", "rawInput": { "CommandLine": "ls", "Cwd": "E:\\w" } });
        assert_eq!(n.update(&exec)[0], AgentEvent::ToolCall { id: "c3".into(), call: ToolCall::Exec { command: "ls".into() } });
        let failed = json!({ "sessionUpdate": "tool_call_update", "toolCallId": "c3", "status": "failed",
            "content": [{ "type": "content", "content": { "type": "text", "text": "boom" } }] });
        assert_eq!(
            n.update(&failed),
            [AgentEvent::ToolResult { id: "c3".into(), is_error: true, output: Some("boom".into()) }]
        );
    }

    #[test]
    fn edits_take_the_diff() {
        let mut n = Normalizer::default();
        let edit = json!({ "sessionUpdate": "tool_call", "toolCallId": "e", "name": "edit_file", "kind": "edit",
            "rawInput": { "Path": "/w/a.rs" },
            "content": [{ "type": "diff", "path": "/w/a.rs", "oldText": "a", "newText": "b" }] });
        assert_eq!(
            n.update(&edit)[0],
            AgentEvent::ToolCall {
                id: "e".into(),
                call: ToolCall::EditFile { path: "/w/a.rs".into(), old_string: Some("a".into()), new_string: Some("b".into()) }
            }
        );
    }

    #[test]
    fn plans_are_one_todo_list_per_turn() {
        let mut n = Normalizer::default();
        let plan = json!({ "sessionUpdate": "plan", "entries": [
            { "content": "Read", "status": "completed", "priority": "high" },
            { "content": "Write", "status": "in_progress", "priority": "high" } ] });
        let first = n.update(&plan);
        assert_eq!(n.update(&plan), first, "the same turn refreshes the same list");
        let AgentEvent::ToolCall { id, call: ToolCall::Todo { items } } = &first[0] else { panic!() };
        assert_eq!(id, "agy-plan-1");
        assert_eq!(items[1].status, TodoStatus::InProgress);
        n.start_turn();
        let AgentEvent::ToolCall { id, .. } = &n.update(&plan)[0] else { panic!() };
        assert_eq!(id, "agy-plan-2");
    }

    #[test]
    fn commands_split_into_builtins_and_skills() {
        let listed = commands(&json!([
            { "name": "compact", "description": "Compact the conversation now." },
            { "name": "goal", "description": "Run until done.", "input": { "hint": "objective" } },
            { "name": "frontend-design", "description": "Design." }
        ]));
        assert_eq!(listed[0].kind, CommandKind::Command);
        assert_eq!(listed[1].input_hint.as_deref(), Some("objective"));
        assert_eq!(listed[2].kind, CommandKind::Skill);
    }
}
