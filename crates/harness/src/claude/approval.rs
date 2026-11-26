//! What a `can_use_tool` request asks of the user. The access mode decides
//! whether a tool call is asked about at all; `AskUserQuestion` (the agent's
//! own questions) and `ExitPlanMode` (plan mode's plan) always are.

use std::collections::HashSet;

use outcode_proto::{AccessMode, InputRequest, ToolCall, UserInputOption, UserInputQuestion};
use serde_json::Value;

use super::normalize::decode_tool_use;
use super::wire::ControlRequestBody;

/// What a refused call tells the agent.
pub(super) const DENIED: &str = "The user did not allow this.";

/// Claude's file-changing tools: auto-accept edits allows these unasked.
const EDIT_TOOLS: [&str; 4] = ["Edit", "Write", "MultiEdit", "NotebookEdit"];

/// A `can_use_tool` request waiting on the user, with what answering it
/// needs.
pub(super) enum Pending {
    Questions {
        input: Value,
        questions: Vec<UserInputQuestion>,
    },
    Approval {
        input: Value,
        /// What "allow for the session" remembers ([`key`]).
        key: String,
        /// The CLI's own rules for allowing calls like it from now on.
        rules: Option<Value>,
    },
    Plan {
        input: Value,
    },
}

/// What `body` has to ask the user, or `None` to allow it now. `allowed`
/// holds the calls allowed for the session.
pub(super) fn ask(
    body: &ControlRequestBody,
    access: AccessMode,
    allowed: &HashSet<String>,
) -> Option<(Pending, InputRequest)> {
    let input = &body.input;
    match body.tool_name.as_str() {
        "AskUserQuestion" => {
            let questions = parse_questions(input);
            let request = InputRequest::Questions {
                questions: questions.clone(),
            };
            Some((
                Pending::Questions {
                    input: input.clone(),
                    questions,
                },
                request,
            ))
        }
        "ExitPlanMode" => {
            let plan = input.get("plan").and_then(Value::as_str).unwrap_or_default();
            Some((
                Pending::Plan { input: input.clone() },
                InputRequest::Plan { plan: plan.into() },
            ))
        }
        tool => {
            let edit = EDIT_TOOLS.contains(&tool);
            let free = match access {
                AccessMode::FullAccess => true,
                AccessMode::AutoAcceptEdits => edit,
                AccessMode::Supervised => false,
            };
            // Outcode's own tools act through Outcode itself: never asked about.
            let outcode = tool.strip_prefix("mcp__outcode__").is_some();
            let key = key(tool, input);
            if free || outcode || allowed.contains(&key) {
                return None;
            }
            let call = decode_tool_use(tool, input);
            let request = InputRequest::Approval {
                title: title(tool, body.display_name.as_deref(), &call),
                call: Some(call),
                tool_call_id: body.tool_use_id.clone(),
                reason: body
                    .description
                    .as_deref()
                    .map(str::trim)
                    .filter(|d| !d.is_empty())
                    .map(Into::into),
            };
            Some((
                Pending::Approval {
                    input: input.clone(),
                    key,
                    rules: body.permission_suggestions.clone().filter(|r| r.as_array().is_some_and(|a| !a.is_empty())),
                },
                request,
            ))
        }
    }
}

/// What allowing a call for the session covers: the same command again, any
/// change to files, or the tool.
pub(super) fn key(tool: &str, input: &Value) -> String {
    match tool {
        "Bash" | "PowerShell" => {
            let command = input.get("command").and_then(Value::as_str).unwrap_or_default();
            format!("{tool}:{}", command.trim())
        }
        _ if EDIT_TOOLS.contains(&tool) => "edit".into(),
        _ => tool.into(),
    }
}

/// The approval's heading.
fn title(tool: &str, display_name: Option<&str>, call: &ToolCall) -> String {
    match call {
        ToolCall::Exec { .. } => "Run command".into(),
        ToolCall::WriteFile { .. } => "Write file".into(),
        ToolCall::EditFile { .. } => "Edit file".into(),
        ToolCall::WebFetch { .. } => "Fetch web page".into(),
        ToolCall::WebSearch { .. } => "Search the web".into(),
        ToolCall::Mcp { server, tool, .. } => format!("Use {server} · {tool}"),
        _ => {
            let name = display_name.map(str::trim).filter(|n| !n.is_empty()).unwrap_or(tool);
            format!("Use {name}")
        }
    }
}

/// `AskUserQuestion`'s input → questions.
fn parse_questions(input: &Value) -> Vec<UserInputQuestion> {
    fn list(value: Option<&Value>) -> &[Value] {
        value.and_then(Value::as_array).map_or(&[][..], Vec::as_slice)
    }
    list(input.get("questions"))
        .iter()
        .enumerate()
        .map(|(i, q)| {
            let field = |key: &str| q.get(key).and_then(Value::as_str).unwrap_or("").trim();
            UserInputQuestion {
                id: format!("q{i}"),
                header: match field("header") {
                    "" => "Question".into(),
                    header => header.into(),
                },
                question: field("question").into(),
                options: list(q.get("options"))
                    .iter()
                    .filter_map(|o| match o {
                        Value::String(label) => Some(UserInputOption {
                            label: label.clone(),
                            description: None,
                        }),
                        other => Some(UserInputOption {
                            label: other.get("label").and_then(Value::as_str)?.into(),
                            description: other
                                .get("description")
                                .and_then(Value::as_str)
                                .filter(|d| !d.trim().is_empty())
                                .map(Into::into),
                        }),
                    })
                    .collect(),
                multi_select: q.get("multiSelect").and_then(Value::as_bool).unwrap_or(false),
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn body(tool: &str, input: Value) -> ControlRequestBody {
        ControlRequestBody {
            subtype: "can_use_tool".into(),
            tool_name: tool.into(),
            input,
            ..ControlRequestBody::default()
        }
    }

    fn asks(tool: &str, input: Value, access: AccessMode) -> Option<InputRequest> {
        ask(&body(tool, input), access, &HashSet::new()).map(|(_, r)| r)
    }

    #[test]
    fn access_modes_decide_what_is_asked() {
        use AccessMode::*;
        for tool in ["Bash", "Edit", "WebFetch", "mcp__x__y"] {
            assert_eq!(asks(tool, json!({}), FullAccess), None, "{tool}");
        }
        assert_eq!(asks("Edit", json!({ "file_path": "a.rs" }), AutoAcceptEdits), None);
        assert!(matches!(
            asks("Bash", json!({ "command": "rm -rf build" }), AutoAcceptEdits),
            Some(InputRequest::Approval { title, call: Some(ToolCall::Exec { command }), .. })
                if title == "Run command" && command == "rm -rf build"
        ));
        assert!(matches!(
            asks("Write", json!({ "file_path": "a.rs" }), Supervised),
            Some(InputRequest::Approval { call: Some(ToolCall::WriteFile { .. }), .. })
        ));
    }

    #[test]
    fn plans_and_questions_are_always_asked() {
        assert_eq!(
            asks("ExitPlanMode", json!({ "plan": "1. Do it" }), AccessMode::FullAccess),
            Some(InputRequest::Plan { plan: "1. Do it".into() })
        );
        let Some(InputRequest::Questions { questions }) = asks(
            "AskUserQuestion",
            json!({ "questions": [
                { "header": "Fix", "question": "Which one?", "options": [{ "label": "A", "description": "first" }, "B"] },
                { "question": "Also?", "options": ["X"], "multiSelect": true },
            ] }),
            AccessMode::FullAccess,
        ) else {
            panic!("no questions");
        };
        assert_eq!(questions[0].options[0].description.as_deref(), Some("first"));
        assert_eq!(questions[0].options[1].label, "B");
        assert_eq!(questions[1].header, "Question");
        assert!(questions[1].multi_select);
    }

    #[test]
    fn calls_allowed_for_the_session_are_not_asked_again() {
        let mut allowed = HashSet::new();
        allowed.insert(key("Bash", &json!({ "command": "cargo test" })));
        allowed.insert(key("Edit", &json!({})));
        let supervised = AccessMode::Supervised;
        assert!(ask(&body("Bash", json!({ "command": "cargo test" })), supervised, &allowed).is_none());
        assert!(ask(&body("Bash", json!({ "command": "rm x" })), supervised, &allowed).is_some());
        assert!(ask(&body("Write", json!({ "file_path": "b" })), supervised, &allowed).is_none());
    }
}
