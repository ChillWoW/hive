//! Folding a turn's [`AgentEvent`]s into its message parts.
//!
//! Mirrored by `src/transcript/fold.ts` for the live stream in the UI; keep
//! the two in step.

use crate::agent::{AgentEvent, CompactionStatus, DoneStatus, ToolCall};
use crate::chat::AgentActivity;
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
                    diff: None,
                    subagent: matches!(call, ToolCall::Subagent { .. })
                        .then_some(SubagentStatus::Running),
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

        AgentEvent::Error { message } => push_error(parts, message),

        AgentEvent::Done { status, error, .. } => {
            // A compaction the turn never reported the end of ends with it.
            if let Some(MessagePart::Compaction { status: s, .. }) = running_compaction(parts) {
                *s = match status {
                    DoneStatus::Completed => CompactionStatus::Completed,
                    DoneStatus::Interrupted => CompactionStatus::Stopped,
                    DoneStatus::Errored => CompactionStatus::Failed,
                };
            }
            if let Some(message) = error {
                push_error(parts, message);
            }
        }

        // The parent transcript keeps only the spawn chip; the subagent's own
        // content folds into the chip's `thread`, its view. A nested spawn's
        // traffic can come tagged with its own id, so the spawn is looked
        // for in threads too.
        AgentEvent::Subagent {
            parent_tool_id,
            event,
        } => {
            let Some(MessagePart::Tool {
                call: ToolCall::Subagent { .. },
                subagent,
                thread,
                ..
            }) = find_spawn(parts, parent_tool_id)
            else {
                return;
            };
            if !matches!(event.as_ref(), AgentEvent::SessionStarted { .. }) {
                fold_event(thread, event);
            }
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

        AgentEvent::ContextUsage { .. }
        | AgentEvent::Usage { .. }
        | AgentEvent::AvailableCommands { .. }
        | AgentEvent::BackgroundTasks { .. }
        | AgentEvent::GoalChanged { .. } => {}
    }
}

fn push_error(parts: &mut Vec<MessagePart>, message: &str) {
    let id = format!("e{}", parts.len());
    parts.push(MessagePart::Error {
        id,
        message: message.to_owned(),
    });
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

fn find_tool<'a>(parts: &'a mut [MessagePart], id: &str) -> Option<&'a mut MessagePart> {
    parts
        .iter_mut()
        .find(|p| matches!(p, MessagePart::Tool { id: pid, .. } if pid == id))
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
        AgentEvent::Subagent {
            parent_tool_id,
            event,
        } => match event.as_ref() {
            AgentEvent::Done { .. } => {
                if let Some(MessagePart::Tool { ended_at, .. }) = find_spawn(parts, parent_tool_id)
                {
                    ended_at.get_or_insert(now);
                }
            }
            // A spawn inside a subagent's thread; spawns are looked for in threads.
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
        MessagePart::Tool {
            subagent, thread, ..
        } => *subagent == Some(SubagentStatus::Running) || has_running_spawn(thread),
        _ => false,
    })
}

/// What a reply folded so far is doing now ([`crate::Session::activity`]):
/// the newest call still running among the latest calls (they may run side
/// by side), else the latest of them, else what it streams last (thinking,
/// text, a compaction). `None` before anything shows.
pub fn activity_of(parts: &[MessagePart]) -> Option<AgentActivity> {
    let mut finished: Option<&ToolCall> = None;
    for part in parts.iter().rev() {
        match part {
            MessagePart::Tool {
                call,
                resolved,
                subagent,
                ..
            } => {
                let running = !*resolved || *subagent == Some(SubagentStatus::Running);
                if running {
                    return Some(AgentActivity::Tool {
                        call: brief(call),
                        running: true,
                    });
                }
                finished.get_or_insert(call);
            }
            // Past the latest calls.
            _ if finished.is_some() => break,
            MessagePart::Reasoning { text, .. } => {
                return Some(AgentActivity::Thinking {
                    heading: latest_heading(text),
                });
            }
            MessagePart::Text { text, .. } if !text.trim().is_empty() => {
                return Some(AgentActivity::Writing);
            }
            MessagePart::Compaction {
                status: CompactionStatus::Running,
                ..
            } => return Some(AgentActivity::Compacting),
            _ => {}
        }
    }
    finished.map(|call| AgentActivity::Tool {
        call: brief(call),
        running: false,
    })
}

/// A call with what only its full view needs left out, sent on every change.
fn brief(call: &ToolCall) -> ToolCall {
    const MAX_COMMAND: usize = 240;
    const MAX_INPUT: usize = 512;
    let small = |input: &Option<serde_json::Value>| {
        input
            .as_ref()
            .filter(|v| v.to_string().len() <= MAX_INPUT)
            .cloned()
    };
    match call {
        ToolCall::Exec { command } => ToolCall::Exec {
            command: command.chars().take(MAX_COMMAND).collect(),
        },
        ToolCall::WriteFile { path, .. } => ToolCall::WriteFile {
            path: path.clone(),
            content: None,
        },
        ToolCall::EditFile { path, .. } => ToolCall::EditFile {
            path: path.clone(),
            old_string: None,
            new_string: None,
        },
        ToolCall::Subagent {
            description,
            model,
            agent,
            ..
        } => ToolCall::Subagent {
            description: description.clone(),
            model: model.clone(),
            prompt: None,
            agent: agent.clone(),
        },
        ToolCall::Mcp {
            server,
            tool,
            input,
        } => ToolCall::Mcp {
            server: server.clone(),
            tool: tool.clone(),
            input: small(input),
        },
        ToolCall::Unknown { name, input } => ToolCall::Unknown {
            name: name.clone(),
            input: small(input),
        },
        other => other.clone(),
    }
}

/// The last `**Heading**` line of a thought (Codex opens each section of
/// its summaries with one).
fn latest_heading(text: &str) -> Option<String> {
    text.lines().rev().find_map(|line| {
        let inner = line.trim().strip_prefix("**")?.strip_suffix("**")?.trim();
        (!inner.is_empty() && !inner.contains('*')).then(|| inner.chars().take(120).collect())
    })
}

/// A subagent spawn by its call id, at this level or in a spawn's thread.
fn find_spawn<'a>(parts: &'a mut [MessagePart], id: &str) -> Option<&'a mut MessagePart> {
    if let Some(i) = parts
        .iter()
        .position(|p| matches!(p, MessagePart::Tool { id: pid, .. } if pid == id))
    {
        return Some(&mut parts[i]);
    }
    parts.iter_mut().find_map(|p| match p {
        MessagePart::Tool { thread, .. } => find_spawn(thread, id),
        _ => None,
    })
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
    fn activity_follows_the_reply() {
        assert_eq!(activity_of(&[]), None);
        let thinking = fold(&[AgentEvent::ReasoningDelta {
            text: "**Reading code**\n\nLooking.\n**Planning the fix**\nhm".into(),
        }]);
        assert_eq!(
            activity_of(&thinking),
            Some(AgentActivity::Thinking {
                heading: Some("Planning the fix".into())
            })
        );
        assert_eq!(activity_of(&fold(&[text("Hi")])), Some(AgentActivity::Writing));

        // Two calls side by side: the one still running, whichever is newer.
        let running = fold(&[
            text("Let me look."),
            exec("t1"),
            exec("t2"),
            AgentEvent::ToolResult {
                id: "t2".into(),
                is_error: false,
                output: None,
                diff: None,
            },
        ]);
        let ls = ToolCall::Exec {
            command: "ls".into(),
        };
        assert_eq!(
            activity_of(&running),
            Some(AgentActivity::Tool {
                call: ls.clone(),
                running: true
            })
        );
        let mut done = running.clone();
        fold_event(
            &mut done,
            &AgentEvent::ToolResult {
                id: "t1".into(),
                is_error: false,
                output: None,
                diff: None,
            },
        );
        assert_eq!(
            activity_of(&done),
            Some(AgentActivity::Tool {
                call: ls,
                running: false
            })
        );

        // An edit's text stays out.
        let edit = fold(&[AgentEvent::ToolCall {
            id: "e".into(),
            call: ToolCall::EditFile {
                path: "a.rs".into(),
                old_string: Some("old".into()),
                new_string: Some("new".into()),
            },
        }]);
        assert_eq!(
            activity_of(&edit),
            Some(AgentActivity::Tool {
                call: ToolCall::EditFile {
                    path: "a.rs".into(),
                    old_string: None,
                    new_string: None
                },
                running: true
            })
        );
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
                prompt: None,
                agent: None,
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
    fn subagent_traffic_folds_into_its_thread_nested_spawns_too() {
        let spawn = |id: &str| AgentEvent::ToolCall {
            id: id.into(),
            call: ToolCall::Subagent {
                description: "d".into(),
                model: None,
                prompt: None,
                agent: None,
            },
        };
        let tagged = |parent: &str, event| AgentEvent::Subagent {
            parent_tool_id: parent.into(),
            event: Box::new(event),
        };
        let parts = fold(&[
            spawn("a"),
            tagged("a", text("look")),
            tagged("a", spawn("b")),
            // Claude tags a nested subagent's traffic with its own spawn id.
            tagged("b", text("deep")),
            tagged("a", text("ed")),
        ]);
        assert_eq!(parts.len(), 1);
        let MessagePart::Tool { thread, .. } = &parts[0] else {
            panic!("spawn part");
        };
        assert_eq!(thread.len(), 3);
        assert!(matches!(&thread[0], MessagePart::Text { text, .. } if text == "look"));
        assert!(matches!(
            &thread[1],
            MessagePart::Tool { thread: inner, subagent: Some(SubagentStatus::Running), .. }
                if matches!(&inner[..], [MessagePart::Text { text, .. }] if text == "deep")
        ));
        assert!(matches!(&thread[2], MessagePart::Text { text, .. } if text == "ed"));
    }

    #[test]
    fn stamps_when_a_subagent_started_and_ended_nested_ones_too() {
        let spawn = |id: &str| AgentEvent::ToolCall {
            id: id.into(),
            call: ToolCall::Subagent {
                description: "d".into(),
                model: None,
                prompt: None,
                agent: None,
            },
        };
        let tagged = |parent: &str, event| AgentEvent::Subagent {
            parent_tool_id: parent.into(),
            event: Box::new(event),
        };
        let done = || AgentEvent::Done {
            status: DoneStatus::Completed,
            error: None,
            session_id: None,
        };
        let mut parts = Vec::new();
        for (at, event) in [
            (10, spawn("a")),
            (20, tagged("a", spawn("b"))),
            (30, tagged("b", done())),
            (40, tagged("a", done())),
            (50, tagged("a", done())),
        ] {
            fold_event(&mut parts, &event);
            stamp_event(&mut parts, &event, at);
        }
        let MessagePart::Tool {
            started_at,
            ended_at,
            thread,
            ..
        } = &parts[0]
        else {
            panic!("spawn part");
        };
        assert_eq!((*started_at, *ended_at), (Some(10), Some(40)));
        assert!(matches!(
            &thread[0],
            MessagePart::Tool { started_at: Some(20), ended_at: Some(30), .. }
        ));
    }

    #[test]
    fn a_compaction_updates_in_place_and_ends_with_the_turn() {
        let compaction = |status, after| AgentEvent::Compaction {
            status,
            auto: false,
            before_tokens: Some(100),
            after_tokens: after,
            error: None,
        };
        let done = |status| AgentEvent::Done {
            status,
            error: None,
            session_id: None,
        };
        let parts = fold(&[
            compaction(CompactionStatus::Running, None),
            compaction(CompactionStatus::Completed, Some(20)),
        ]);
        assert!(matches!(
            parts.as_slice(),
            [MessagePart::Compaction {
                status: CompactionStatus::Completed,
                before_tokens: Some(100),
                after_tokens: Some(20),
                ..
            }]
        ));
        let parts = fold(&[
            compaction(CompactionStatus::Running, None),
            done(DoneStatus::Interrupted),
        ]);
        assert!(matches!(
            parts.as_slice(),
            [MessagePart::Compaction {
                status: CompactionStatus::Stopped,
                ..
            }]
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
