//! Folding a turn's [`AgentEvent`]s into its message parts.
//!
//! Mirrored by `src/features/chat/fold.ts` for the live stream in the UI;
//! keep the two in step.

use crate::agent::AgentEvent;
use crate::message::MessagePart;

/// Folds one event into `parts`, in place.
///
/// - Deltas grow the trailing text/reasoning part, or start one if the trail
///   is something else (a tool call in between splits a text block).
/// - A `ToolCall` with a known id refreshes that part in place, which is how
///   a live todo list updates; `ToolResult` resolves it.
/// - `Done` adds nothing: how the turn ended is the message's status;
///   `SessionStarted` adds nothing either.
pub fn fold_event(parts: &mut Vec<MessagePart>, event: &AgentEvent) {
    match event {
        AgentEvent::TextDelta { text } => {
            if let Some(MessagePart::Text { text: tail, .. }) = parts.last_mut() {
                tail.push_str(text);
            } else if !text.is_empty() {
                let id = format!("t{}", parts.len());
                parts.push(MessagePart::Text {
                    id,
                    text: text.clone(),
                });
            }
        }

        AgentEvent::ReasoningDelta { text } => {
            if let Some(MessagePart::Reasoning { text: tail, .. }) = parts.last_mut() {
                tail.push_str(text);
            } else if !text.is_empty() {
                let id = format!("r{}", parts.len());
                parts.push(MessagePart::Reasoning {
                    id,
                    text: text.clone(),
                });
            }
        }

        AgentEvent::ToolCall { id, call } => {
            if let Some(MessagePart::Tool { call: existing, .. }) = find_tool(parts, id) {
                *existing = call.clone();
            } else {
                parts.push(MessagePart::Tool {
                    id: id.clone(),
                    call: call.clone(),
                    resolved: false,
                    is_error: false,
                    output: None,
                });
            }
        }

        AgentEvent::ToolResult {
            id,
            is_error,
            output,
        } => {
            if let Some(MessagePart::Tool {
                resolved,
                is_error: error_slot,
                output: output_slot,
                ..
            }) = find_tool(parts, id)
            {
                *resolved = true;
                *error_slot = *is_error;
                *output_slot = output.clone();
            }
        }

        AgentEvent::Error { message } => {
            let id = format!("e{}", parts.len());
            parts.push(MessagePart::Error {
                id,
                message: message.clone(),
            });
        }

        AgentEvent::SessionStarted { .. } | AgentEvent::Done { .. } => {}
    }
}

fn find_tool<'a>(parts: &'a mut [MessagePart], id: &str) -> Option<&'a mut MessagePart> {
    parts
        .iter_mut()
        .find(|p| matches!(p, MessagePart::Tool { id: pid, .. } if pid == id))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::{DoneStatus, TodoItem, TodoStatus, ToolCall};

    fn fold(events: &[AgentEvent]) -> Vec<MessagePart> {
        let mut parts = Vec::new();
        for event in events {
            fold_event(&mut parts, event);
        }
        parts
    }

    fn text(t: &str) -> AgentEvent {
        AgentEvent::TextDelta { text: t.into() }
    }

    fn thought(t: &str) -> AgentEvent {
        AgentEvent::ReasoningDelta { text: t.into() }
    }

    fn exec(id: &str, command: &str) -> AgentEvent {
        AgentEvent::ToolCall {
            id: id.into(),
            call: ToolCall::Exec {
                command: command.into(),
            },
        }
    }

    #[test]
    fn deltas_merge_until_something_else_comes() {
        let parts = fold(&[
            thought("Let me "),
            thought("look."),
            text("Hel"),
            text("lo"),
            exec("call", "ls"),
            text("Done"),
            AgentEvent::Done {
                status: DoneStatus::Completed,
            },
        ]);
        let ids: Vec<&str> = parts.iter().map(MessagePart::id).collect();
        assert_eq!(ids, ["r0", "t1", "call", "t3"]);
        assert_eq!(
            parts[0],
            MessagePart::Reasoning {
                id: "r0".into(),
                text: "Let me look.".into()
            }
        );
        assert_eq!(
            parts[1],
            MessagePart::Text {
                id: "t1".into(),
                text: "Hello".into()
            }
        );
    }

    #[test]
    fn empty_deltas_start_nothing() {
        assert!(fold(&[text(""), thought("")]).is_empty());
    }

    #[test]
    fn result_resolves_its_call() {
        let parts = fold(&[
            exec("a", "ls"),
            exec("b", "false"),
            AgentEvent::ToolResult {
                id: "b".into(),
                is_error: true,
                output: Some("exit 1".into()),
            },
            AgentEvent::ToolResult {
                id: "missing".into(),
                is_error: false,
                output: None,
            },
        ]);
        assert_eq!(parts.len(), 2);
        assert!(matches!(&parts[0], MessagePart::Tool { resolved: false, .. }));
        assert!(matches!(
            &parts[1],
            MessagePart::Tool { resolved: true, is_error: true, output: Some(o), .. } if o == "exit 1"
        ));
    }

    #[test]
    fn same_call_id_refreshes_in_place() {
        let todo = |status| AgentEvent::ToolCall {
            id: "todo".into(),
            call: ToolCall::Todo {
                items: vec![TodoItem {
                    text: "Ship".into(),
                    status,
                }],
            },
        };
        let parts = fold(&[todo(TodoStatus::Pending), text("x"), todo(TodoStatus::Completed)]);
        assert_eq!(parts.len(), 2);
        assert!(matches!(
            &parts[0],
            MessagePart::Tool { call: ToolCall::Todo { items }, .. } if items[0].status == TodoStatus::Completed
        ));
    }

    #[test]
    fn errors_become_parts() {
        let parts = fold(&[
            text("a"),
            AgentEvent::Error {
                message: "boom".into(),
            },
        ]);
        assert_eq!(
            parts[1],
            MessagePart::Error {
                id: "e1".into(),
                message: "boom".into()
            }
        );
    }
}
