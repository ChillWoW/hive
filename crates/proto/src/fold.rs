//! Folding a turn's [`AgentEvent`]s into its message parts.
//!
//! Mirrored by `src/features/chat/fold.ts` for the live stream in the UI;
//! keep the two in step.

use crate::agent::{AgentEvent, CompactionStatus, DoneStatus, ToolCall};
use crate::message::{MessagePart, SubagentStatus};

/// Folds one event into `parts`, in place.
///
/// - Deltas grow the trailing text/reasoning part, or start one if the trail
///   is something else (a tool call in between splits a text block).
/// - A `ToolCall` with a known id refreshes that part in place, which is how
///   a live todo list updates; `ToolResult` resolves it.
/// - A subagent's events fold into its spawn part's `thread`.
/// - Session state (usage, commands, background tasks) adds nothing, and
///   neither does `Done` but for settling what the turn left open: how the
///   turn ended is the message's status.
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
                    subagent: matches!(call, ToolCall::Subagent { .. }).then_some(SubagentStatus::Running),
                    thread: Vec::new(),
                    started_at: None,
                    ended_at: None,
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

        AgentEvent::InputRequested { request_id, request } => {
            let id = format!("in-{request_id}");
            if !parts.iter().any(|p| p.id() == id) {
                parts.push(MessagePart::Input {
                    id,
                    request_id: request_id.clone(),
                    request: request.clone(),
                    resolved: false,
                    response: None,
                });
            }
        }

        AgentEvent::InputResolved { request_id, response } => {
            for part in parts.iter_mut() {
                if let MessagePart::Input {
                    request_id: rid,
                    resolved,
                    response: slot,
                    ..
                } = part
                    && rid == request_id
                {
                    *resolved = true;
                    *slot = response.clone();
                }
            }
        }

        AgentEvent::Compaction {
            status,
            auto,
            before_tokens,
            after_tokens,
            error,
        } => {
            if let Some(MessagePart::Compaction {
                status: s,
                auto: a,
                before_tokens: b,
                after_tokens: af,
                error: e,
                ..
            }) = running_compaction(parts)
            {
                *s = *status;
                *a |= *auto;
                *b = before_tokens.or(*b);
                *af = after_tokens.or(*af);
                if error.is_some() {
                    *e = error.clone();
                }
            } else {
                let id = format!("c{}", parts.len());
                parts.push(MessagePart::Compaction {
                    id,
                    status: *status,
                    auto: *auto,
                    before_tokens: *before_tokens,
                    after_tokens: *after_tokens,
                    error: error.clone(),
                });
            }
        }

        AgentEvent::BackgroundTurn { finished } => {
            let id = format!("w{}", parts.len());
            parts.push(MessagePart::Wake {
                id,
                finished: finished.clone(),
            });
        }

        AgentEvent::Subagent { parent_tool_id, event } => {
            let Some(MessagePart::Tool { subagent, thread, .. }) = find_spawn(parts, parent_tool_id) else {
                return;
            };
            fold_event(thread, event);
            match event.as_ref() {
                AgentEvent::Done { status } => {
                    *subagent = Some(match status {
                        DoneStatus::Errored => SubagentStatus::Failed,
                        _ => SubagentStatus::Done,
                    });
                }
                // A nested spawn's traffic says nothing about this one.
                AgentEvent::Subagent { .. } => {}
                _ => {
                    if subagent.is_none() {
                        *subagent = Some(SubagentStatus::Running);
                    }
                }
            }
        }

        AgentEvent::Error { message } => {
            let id = format!("e{}", parts.len());
            parts.push(MessagePart::Error {
                id,
                message: message.clone(),
            });
        }

        AgentEvent::Done { status } => {
            // A compaction the turn never reported the end of ends with it.
            if let Some(MessagePart::Compaction { status: s, .. }) = running_compaction(parts) {
                *s = match status {
                    DoneStatus::Completed => CompactionStatus::Completed,
                    DoneStatus::Interrupted => CompactionStatus::Stopped,
                    DoneStatus::Errored => CompactionStatus::Failed,
                };
            }
            // Nothing can answer these any more.
            for part in parts.iter_mut() {
                if let MessagePart::Input { resolved, .. } = part {
                    *resolved = true;
                }
            }
        }

        AgentEvent::SessionStarted { .. }
        | AgentEvent::ContextUsage { .. }
        | AgentEvent::Usage { .. }
        | AgentEvent::AvailableCommands { .. }
        | AgentEvent::BackgroundTasks { .. }
        | AgentEvent::PromptSuggestion { .. } => {}
    }
}

fn find_tool<'a>(parts: &'a mut [MessagePart], id: &str) -> Option<&'a mut MessagePart> {
    parts
        .iter_mut()
        .find(|p| matches!(p, MessagePart::Tool { id: pid, .. } if pid == id))
}

fn running_compaction(parts: &mut [MessagePart]) -> Option<&mut MessagePart> {
    parts.iter_mut().rev().find(|p| {
        matches!(
            p,
            MessagePart::Compaction {
                status: CompactionStatus::Running,
                ..
            }
        )
    })
}

/// The spawn part `id`, nested spawns (in threads) included.
fn find_spawn<'a>(parts: &'a mut [MessagePart], id: &str) -> Option<&'a mut MessagePart> {
    let at = parts.iter().position(
        |p| matches!(p, MessagePart::Tool { id: pid, call: ToolCall::Subagent { .. }, .. } if pid == id),
    );
    if let Some(at) = at {
        return Some(&mut parts[at]);
    }
    parts.iter_mut().find_map(|p| match p {
        MessagePart::Tool { thread, .. } if !thread.is_empty() => find_spawn(thread, id),
        _ => None,
    })
}


/// Stamps when a subagent was spawned and when it finished on its spawn
/// part, `now` being when `event` came. Call it after [`fold_event`] with the
/// same event; folding itself has no clock.
pub fn stamp_event(parts: &mut [MessagePart], event: &AgentEvent, now: i64) {
    match event {
        AgentEvent::ToolCall {
            id,
            call: ToolCall::Subagent { .. },
        } => {
            if let Some(MessagePart::Tool { started_at, .. }) = find_spawn(parts, id) {
                started_at.get_or_insert(now);
            }
        }
        AgentEvent::Subagent { parent_tool_id, event } => match event.as_ref() {
            AgentEvent::Done { .. } => {
                if let Some(MessagePart::Tool { ended_at, .. }) = find_spawn(parts, parent_tool_id) {
                    ended_at.get_or_insert(now);
                }
            }
            // A spawn inside a subagent's thread.
            inner => stamp_event(parts, inner, now),
        },
        _ => {}
    }
}

/// Whether `parts` hold the subagent spawn `id`, nested ones included: where
/// its [`AgentEvent::Subagent`] traffic folds.
pub fn has_spawn(parts: &[MessagePart], id: &str) -> bool {
    parts.iter().any(|p| match p {
        MessagePart::Tool {
            id: pid,
            call: ToolCall::Subagent { .. },
            ..
        } if pid == id => true,
        MessagePart::Tool { thread, .. } => has_spawn(thread, id),
        _ => false,
    })
}
/// Whether a subagent spawned in `parts` (nested ones included) still runs.
pub fn has_running_spawn(parts: &[MessagePart]) -> bool {
    parts.iter().any(|p| match p {
        MessagePart::Tool { subagent, thread, .. } => {
            *subagent == Some(SubagentStatus::Running) || has_running_spawn(thread)
        }
        _ => false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::{InputRequest, InputResponse, TodoItem, TodoStatus};

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

    #[test]
    fn subagent_traffic_folds_into_its_spawn() {
        let spawn = AgentEvent::ToolCall {
            id: "s".into(),
            call: ToolCall::Subagent {
                description: "scan".into(),
                model: None,
                prompt: None,
                agent: None,
            },
        };
        let inner = |event| AgentEvent::Subagent {
            parent_tool_id: "s".into(),
            event: Box::new(event),
        };
        let parts = fold(&[
            spawn,
            inner(text("looking")),
            inner(exec("x", "ls")),
            AgentEvent::ToolResult {
                id: "s".into(),
                is_error: false,
                output: None,
            },
        ]);
        let MessagePart::Tool { subagent, thread, .. } = &parts[0] else {
            panic!("{parts:?}");
        };
        assert_eq!(parts.len(), 1);
        assert_eq!(*subagent, Some(SubagentStatus::Running));
        assert_eq!(thread.len(), 2);
        assert!(has_running_spawn(&parts));

        let mut parts = parts;
        fold_event(&mut parts, &inner(AgentEvent::Done { status: DoneStatus::Completed }));
        assert!(!has_running_spawn(&parts));
    }

    #[test]
    fn input_resolves_and_the_turn_end_settles_the_rest() {
        let ask = |id: &str| AgentEvent::InputRequested {
            request_id: id.into(),
            request: InputRequest::Plan { plan: "p".into() },
        };
        let mut parts = fold(&[
            ask("a"),
            ask("b"),
            AgentEvent::InputResolved {
                request_id: "a".into(),
                response: Some(InputResponse::Plan {
                    approve: true,
                    feedback: None,
                }),
            },
        ]);
        assert!(matches!(&parts[0], MessagePart::Input { resolved: true, response: Some(_), .. }));
        assert!(matches!(&parts[1], MessagePart::Input { resolved: false, .. }));
        fold_event(&mut parts, &AgentEvent::Done { status: DoneStatus::Interrupted });
        assert!(matches!(&parts[1], MessagePart::Input { resolved: true, response: None, .. }));
    }

    #[test]
    fn compaction_runs_then_lands() {
        let compaction = |status| AgentEvent::Compaction {
            status,
            auto: false,
            before_tokens: None,
            after_tokens: Some(10),
            error: None,
        };
        let parts = fold(&[compaction(CompactionStatus::Running), compaction(CompactionStatus::Completed)]);
        assert!(matches!(
            &parts[..],
            [MessagePart::Compaction { status: CompactionStatus::Completed, after_tokens: Some(10), .. }]
        ));
        let parts = fold(&[
            compaction(CompactionStatus::Running),
            AgentEvent::Done { status: DoneStatus::Interrupted },
        ]);
        assert!(matches!(&parts[..], [MessagePart::Compaction { status: CompactionStatus::Stopped, .. }]));
    }

    #[test]
    fn spawns_are_stamped_with_their_start_and_end() {
        let spawn = AgentEvent::ToolCall {
            id: "s".into(),
            call: ToolCall::Subagent {
                description: "scan".into(),
                model: None,
                prompt: None,
                agent: None,
            },
        };
        let done = AgentEvent::Subagent {
            parent_tool_id: "s".into(),
            event: Box::new(AgentEvent::Done { status: DoneStatus::Completed }),
        };
        let mut parts = Vec::new();
        for (event, at) in [(&spawn, 10), (&done, 25)] {
            fold_event(&mut parts, event);
            stamp_event(&mut parts, event, at);
        }
        assert!(matches!(
            &parts[0],
            MessagePart::Tool { started_at: Some(10), ended_at: Some(25), .. }
        ));
    }
}
