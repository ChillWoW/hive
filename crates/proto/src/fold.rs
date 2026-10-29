//! Folding a turn's [`AgentEvent`]s into its message parts.
//!
//! Mirrored by `src/transcript/fold.ts` for the live stream in the UI; keep
//! the two in step.

use crate::agent::{AgentEvent, DoneStatus, ToolCall};
use crate::message::{MessagePart, SubagentStatus};

/// Folds one event into `parts`, in place.
///
/// - Deltas grow the trailing text/reasoning part, or start one if the trail
///   is something else (a tool call in between splits a text block).
/// - A `ToolCall` with a known id refreshes that part in place, which is how
///   a live todo list updates; `ToolResult` resolves it.
/// - Events that aren't transcript content (usage, commands, …) are ignored.
pub fn fold_event(parts: &mut Vec<MessagePart>, event: &AgentEvent) {
    match event {
        AgentEvent::SessionStarted { .. } => parts.clear(),

        AgentEvent::TextDelta { text } => {
            if text.is_empty() {
                return;
            }
            if let Some(MessagePart::Text { text: tail, .. }) = parts.last_mut() {
                tail.push_str(text);
            } else {
                let id = format!("t{}", parts.len());
                parts.push(MessagePart::Text {
                    id,
                    text: text.clone(),
                });
            }
        }

        AgentEvent::ReasoningDelta { text } => {
            if text.is_empty() {
                return;
            }
            if let Some(MessagePart::Reasoning { text: tail, .. }) = parts.last_mut() {
                tail.push_str(text);
            } else {
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
                    diff: None,
                    subagent: matches!(call, ToolCall::Subagent { .. })
                        .then_some(SubagentStatus::Running),
                });
            }
        }

        AgentEvent::ToolResult {
            id,
            is_error,
            output,
            diff,
        } => {
            if let Some(MessagePart::Tool {
                resolved,
                is_error: error_slot,
                output: output_slot,
                diff: diff_slot,
                ..
            }) = find_tool(parts, id)
            {
                *resolved = true;
                *error_slot = *is_error;
                *output_slot = output.clone();
                *diff_slot = diff.clone();
            }
        }

        AgentEvent::InputRequested {
            request_id,
            questions,
        } => {
            let id = format!("in-{request_id}");
            if !parts.iter().any(|p| p.id() == id) {
                parts.push(MessagePart::Input {
                    id,
                    request_id: request_id.clone(),
                    questions: questions.clone(),
                    resolved: false,
                });
            }
        }

        AgentEvent::InputResolved { request_id } => {
            for part in parts.iter_mut() {
                if let MessagePart::Input {
                    request_id: rid,
                    resolved,
                    ..
                } = part
                {
                    if rid == request_id {
                        *resolved = true;
                    }
                }
            }
        }

        AgentEvent::Error { message }
        | AgentEvent::Done {
            error: Some(message),
            ..
        } => {
            let id = format!("e{}", parts.len());
            parts.push(MessagePart::Error {
                id,
                message: message.clone(),
            });
        }

        // The parent transcript keeps only the spawn chip; this tracks its
        // lifecycle. The subagent's own content folds into its own view.
        AgentEvent::Subagent {
            parent_tool_id,
            event,
        } => {
            let Some(MessagePart::Tool {
                call: ToolCall::Subagent { .. },
                subagent,
                ..
            }) = find_tool(parts, parent_tool_id)
            else {
                return;
            };
            match event.as_ref() {
                AgentEvent::Done { status, .. } => {
                    *subagent = Some(match status {
                        DoneStatus::Errored => SubagentStatus::Failed,
                        _ => SubagentStatus::Done,
                    });
                }
                _ if !matches!(
                    subagent,
                    Some(SubagentStatus::Done | SubagentStatus::Failed)
                ) =>
                {
                    *subagent = Some(SubagentStatus::Running);
                }
                _ => {}
            }
        }

        AgentEvent::BackgroundTurn { finished } => {
            let id = format!("w{}", parts.len());
            parts.push(MessagePart::Wake {
                id,
                finished: finished.clone(),
            });
        }

        AgentEvent::Done { error: None, .. }
        | AgentEvent::ContextUsage { .. }
        | AgentEvent::Usage { .. }
        | AgentEvent::AvailableCommands { .. }
        | AgentEvent::BackgroundTasks { .. } => {}
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
    use crate::agent::{TodoItem, TodoStatus};

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

    fn exec(id: &str) -> AgentEvent {
        AgentEvent::ToolCall {
            id: id.into(),
            call: ToolCall::Exec {
                command: "ls".into(),
            },
        }
    }

    #[test]
    fn deltas_merge_until_a_tool_call_splits_them() {
        let parts = fold(&[
            text("Hel"),
            text("lo"),
            exec("t1"),
            AgentEvent::ToolResult {
                id: "t1".into(),
                is_error: true,
                output: Some("nope".into()),
                diff: None,
            },
            text("Done"),
        ]);
        assert_eq!(parts.len(), 3);
        assert!(matches!(&parts[0], MessagePart::Text { text, .. } if text == "Hello"));
        assert!(matches!(
            &parts[1],
            MessagePart::Tool { resolved: true, is_error: true, output: Some(o), .. } if o == "nope"
        ));
        assert!(
            matches!(&parts[2], MessagePart::Text { id, text } if id == "t2" && text == "Done")
        );
    }

    #[test]
    fn a_known_tool_id_refreshes_in_place() {
        let todo = |status| AgentEvent::ToolCall {
            id: "plan".into(),
            call: ToolCall::Todo {
                items: vec![TodoItem {
                    text: "a".into(),
                    status,
                }],
            },
        };
        let parts = fold(&[
            todo(TodoStatus::Pending),
            text("x"),
            todo(TodoStatus::Completed),
        ]);
        assert_eq!(parts.len(), 2);
        assert!(matches!(
            &parts[0],
            MessagePart::Tool { call: ToolCall::Todo { items }, .. } if items[0].status == TodoStatus::Completed
        ));
    }

    #[test]
    fn subagent_lifecycle_never_regresses_from_done() {
        let spawn = AgentEvent::ToolCall {
            id: "a".into(),
            call: ToolCall::Subagent {
                description: "d".into(),
                model: None,
            },
        };
        let tagged = |event| AgentEvent::Subagent {
            parent_tool_id: "a".into(),
            event: Box::new(event),
        };
        let done = AgentEvent::Done {
            status: DoneStatus::Completed,
            error: None,
            session_id: None,
        };
        let parts = fold(&[spawn, tagged(done), tagged(text("late"))]);
        assert!(matches!(
            &parts[0],
            MessagePart::Tool {
                subagent: Some(SubagentStatus::Done),
                ..
            }
        ));
    }

    #[test]
    fn input_and_errors_become_parts() {
        let parts = fold(&[
            AgentEvent::InputRequested {
                request_id: "q".into(),
                questions: vec![],
            },
            AgentEvent::InputResolved {
                request_id: "q".into(),
            },
            AgentEvent::Done {
                status: DoneStatus::Errored,
                error: Some("boom".into()),
                session_id: None,
            },
        ]);
        assert!(matches!(
            &parts[0],
            MessagePart::Input { resolved: true, .. }
        ));
        assert!(matches!(&parts[1], MessagePart::Error { message, .. } if message == "boom"));
    }
}
