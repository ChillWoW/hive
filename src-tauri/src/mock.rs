//! A scripted harness that plays a canned turn through the real wire types,
//! so the transcript UI can be built before any CLI driver exists.

use std::thread;
use std::time::Duration;

use hive_proto::{
    AgentEvent, DoneStatus, HarnessId, SlashCommand, TodoItem, TodoStatus, ToolCall, ToolDiff,
    UserInputQuestion,
};
use tauri::ipc::Channel;

#[tauri::command]
pub fn mock_run(request: hive_proto::RunRequest, on_event: Channel<AgentEvent>) {
    thread::spawn(move || {
        for (delay_ms, event) in script(&request) {
            thread::sleep(Duration::from_millis(delay_ms));
            if on_event.send(event).is_err() {
                // The webview went away (reload, window closed).
                return;
            }
        }
    });
}

/// `(delay before the event in ms, event)` pairs.
fn script(request: &hive_proto::RunRequest) -> Vec<(u64, AgentEvent)> {
    let mut s = Script::default();

    s.push(
        0,
        AgentEvent::SessionStarted {
            harness: HarnessId::Mock,
            model: request.model.clone().unwrap_or_else(|| "mock-1".into()),
            cwd: request.cwd.clone(),
            session_id: "mock-session-1".into(),
            tools: vec!["Bash".into(), "Read".into(), "Edit".into(), "Task".into()],
        },
    );
    s.push(
        0,
        AgentEvent::AvailableCommands {
            commands: vec![SlashCommand {
                name: "review".into(),
                description: "Review the current diff".into(),
                input_hint: Some("focus area".into()),
            }],
        },
    );
    s.reasoning(
        "The user wants a quick look at the project. I'll plan the steps, read the \
         entry point, run the tests, then make a small edit.",
    );

    let todo = |statuses: [TodoStatus; 3]| ToolCall::Todo {
        items: ["Read the entry point", "Run the tests", "Tidy up main"]
            .into_iter()
            .zip(statuses)
            .map(|(text, status)| TodoItem {
                text: text.into(),
                status,
            })
            .collect(),
    };
    use TodoStatus::{Completed as Done, InProgress as Doing, Pending as Todo};
    s.tool(
        "plan",
        todo([Doing, Todo, Todo]),
        Some("Todos updated"),
        None,
        false,
    );

    s.text(&format!(
        "You asked: \"{}\". Let me start by reading the entry point.",
        request.prompt.trim()
    ));
    s.tool(
        "read",
        ToolCall::ReadFile {
            path: "src/main.rs".into(),
        },
        Some("fn main() {\n    println!(\"hello\");\n}"),
        None,
        false,
    );
    s.tool(
        "plan",
        todo([Done, Doing, Todo]),
        Some("Todos updated"),
        None,
        false,
    );
    s.tool(
        "test",
        ToolCall::Exec {
            command: "cargo test".into(),
        },
        Some("running 1 test\ntest smoke ... FAILED\n\nfailures:\n    smoke: assertion failed"),
        None,
        true,
    );
    s.text("One test fails. I'll have a subagent look into it while I search for related code.");

    s.push(
        250,
        AgentEvent::ToolCall {
            id: "agent".into(),
            call: ToolCall::Subagent {
                description: "Investigate failing smoke test".into(),
                model: Some("haiku".into()),
            },
        },
    );
    for text in ["Looking at ", "the smoke test", "…"] {
        s.push(
            120,
            AgentEvent::Subagent {
                parent_tool_id: "agent".into(),
                event: Box::new(AgentEvent::TextDelta { text: text.into() }),
            },
        );
    }
    s.tool(
        "grep",
        ToolCall::Search {
            pattern: "fn smoke".into(),
            path: Some("tests/".into()),
        },
        Some("tests/smoke.rs:3: fn smoke() {"),
        None,
        false,
    );
    s.push(
        600,
        AgentEvent::Subagent {
            parent_tool_id: "agent".into(),
            event: Box::new(AgentEvent::Done {
                status: DoneStatus::Completed,
                error: None,
                session_id: None,
            }),
        },
    );
    s.push(
        0,
        AgentEvent::ToolResult {
            id: "agent".into(),
            is_error: false,
            output: Some("The test expects `hello, world`.".into()),
            diff: None,
        },
    );

    s.push(
        300,
        AgentEvent::InputRequested {
            request_id: "q1".into(),
            questions: vec![UserInputQuestion {
                id: "fix".into(),
                header: "Fix".into(),
                question: "Change the output or the test?".into(),
                options: vec!["Change the output".into(), "Change the test".into()],
                multi_select: false,
            }],
        },
    );
    s.push(
        1500,
        AgentEvent::InputResolved {
            request_id: "q1".into(),
        },
    );

    s.tool(
        "edit",
        ToolCall::EditFile {
            path: "src/main.rs".into(),
            old_string: Some("println!(\"hello\");".into()),
            new_string: Some("println!(\"hello, world\");".into()),
        },
        None,
        Some(ToolDiff {
            path: "src/main.rs".into(),
            old_text: Some("fn main() {\n    println!(\"hello\");\n}\n".into()),
            new_text: "fn main() {\n    println!(\"hello, world\");\n}\n".into(),
        }),
        false,
    );
    s.tool(
        "plan",
        todo([Done, Done, Done]),
        Some("Todos updated"),
        None,
        false,
    );
    s.push(
        0,
        AgentEvent::ContextUsage {
            tokens: Some(48_200),
            window: Some(200_000),
        },
    );
    s.text("Done. `main` now prints `hello, world`, which is what the smoke test expects.");
    s.push(
        0,
        AgentEvent::Usage {
            input_tokens: 48_200,
            output_tokens: 1_310,
        },
    );
    s.push(
        200,
        AgentEvent::Done {
            status: DoneStatus::Completed,
            error: None,
            session_id: Some("mock-session-1".into()),
        },
    );
    s.0
}

#[derive(Default)]
struct Script(Vec<(u64, AgentEvent)>);

impl Script {
    fn push(&mut self, delay_ms: u64, event: AgentEvent) {
        self.0.push((delay_ms, event));
    }

    /// Streams `text` a word at a time, like a model would.
    fn text(&mut self, text: &str) {
        for word in text.split_inclusive(' ') {
            self.push(35, AgentEvent::TextDelta { text: word.into() });
        }
    }

    fn reasoning(&mut self, text: &str) {
        for word in text.split_inclusive(' ') {
            self.push(20, AgentEvent::ReasoningDelta { text: word.into() });
        }
    }

    /// A tool call and its result. Ids repeat on purpose for `plan`: the
    /// fold refreshes a known id in place, which is how a live todo list
    /// updates.
    fn tool(
        &mut self,
        id: &str,
        call: ToolCall,
        output: Option<&str>,
        diff: Option<ToolDiff>,
        is_error: bool,
    ) {
        self.push(
            250,
            AgentEvent::ToolCall {
                id: id.into(),
                call,
            },
        );
        self.push(
            700,
            AgentEvent::ToolResult {
                id: id.into(),
                is_error,
                output: output.map(Into::into),
                diff,
            },
        );
    }
}
