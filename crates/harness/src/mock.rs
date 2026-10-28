//! A scripted harness: plays a canned turn through the real event types and
//! honors the same [`RunHandle`] commands as a real CLI, so the host and UI
//! can be built and tested without spending tokens.
//!
//! Every prompt plays the same turn. It stops at one question and waits for
//! [`RunHandle::answer`]; [`RunHandle::interrupt`] ends the turn early.

use std::collections::VecDeque;
use std::time::Duration;

use hive_proto::{
    AgentEvent, DoneStatus, HarnessCapabilities, HarnessCatalog, HarnessId, Model,
    ReasoningLevel, RunRequest, SandboxLevel, SlashCommand, TodoItem, TodoStatus, ToolCall,
    ToolDiff, UserInputAnswer, UserInputQuestion,
};
use tokio::sync::mpsc;
use tokio::time::Instant;

use crate::{Harness, HarnessError, Run, RunCommand, RunHandle};

const SESSION_ID: &str = "mock-session";

/// `speed` scales every delay: 1.0 plays like a model, 0.0 plays instantly.
pub struct MockHarness {
    speed: f64,
}

impl Default for MockHarness {
    fn default() -> Self {
        Self { speed: 1.0 }
    }
}

impl MockHarness {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_speed(speed: f64) -> Self {
        Self { speed }
    }
}

impl Harness for MockHarness {
    fn id(&self) -> HarnessId {
        HarnessId::Mock
    }

    fn catalog(&self) -> HarnessCatalog {
        let model = |id: &str, label: &str, reasoning: &[ReasoningLevel]| Model {
            id: id.into(),
            label: label.into(),
            description: Some("Plays a scripted turn; spends no tokens".into()),
            reasoning_levels: reasoning.to_vec(),
            options: Vec::new(),
        };
        HarnessCatalog {
            id: HarnessId::Mock,
            label: "Mock".into(),
            installed: true,
            models: vec![
                model(
                    "mock-1",
                    "Mock",
                    &[ReasoningLevel::Low, ReasoningLevel::Medium, ReasoningLevel::High],
                ),
                model("mock-mini", "Mock Mini", &[]),
            ],
            default_model: Some("mock-1".into()),
            commands: vec![SlashCommand {
                name: "review".into(),
                description: "Review the current diff".into(),
                input_hint: Some("focus area".into()),
            }],
            sandbox_levels: vec![
                SandboxLevel::WorkspaceWrite,
                SandboxLevel::ReadOnly,
                SandboxLevel::DangerFullAccess,
            ],
            capabilities: HarnessCapabilities {
                steering: false,
                interrupt: true,
                attachments: false,
            },
        }
    }

    fn run(&self, request: RunRequest) -> Result<Run, HarnessError> {
        let (events_tx, events) = mpsc::channel(256);
        let (handle, commands) = RunHandle::new();
        let player = Player {
            commands,
            commands_open: true,
            events: events_tx,
            queue: VecDeque::from([request.prompt.clone()]),
            closing: false,
            speed: self.speed,
        };
        tokio::spawn(player.run(request));
        Ok(Run { events, handle })
    }
}

enum Step {
    /// Wait this many ms, then emit.
    Emit(u64, AgentEvent),
    /// Emit `InputRequested` and wait for the answer.
    Ask(UserInputQuestion),
}

struct Player {
    commands: mpsc::UnboundedReceiver<RunCommand>,
    commands_open: bool,
    events: mpsc::Sender<AgentEvent>,
    /// Prompts waiting for their turn.
    queue: VecDeque<String>,
    /// Close was asked for: finish the queue, then end.
    closing: bool,
    speed: f64,
}

struct Gone;

enum Interrupted {
    Yes,
    No,
}

impl Player {
    async fn run(mut self, request: RunRequest) {
        let mut turn = 0;
        loop {
            while let Some(prompt) = self.queue.pop_front() {
                if self.play_turn(&request, &prompt, turn).await.is_err() {
                    return;
                }
                turn += 1;
            }
            if self.closing || !self.idle().await {
                return;
            }
        }
    }

    /// Between turns: waits for the next prompt. False once the session
    /// should end.
    async fn idle(&mut self) -> bool {
        while self.queue.is_empty() {
            match self.next_command().await {
                Some(RunCommand::Send(prompt)) => self.queue.push_back(prompt),
                Some(RunCommand::Close) | None => return false,
                Some(RunCommand::Answer { .. } | RunCommand::Interrupt) => {}
            }
        }
        true
    }

    async fn play_turn(
        &mut self,
        request: &RunRequest,
        prompt: &str,
        turn: usize,
    ) -> Result<(), Gone> {
        for step in script(request, prompt, turn) {
            let interrupted = match step {
                Step::Emit(delay, event) => match self.pause(delay).await {
                    Interrupted::No => {
                        self.emit(event).await?;
                        Interrupted::No
                    }
                    yes => yes,
                },
                Step::Ask(question) => self.ask(turn, question).await?,
            };
            if let Interrupted::Yes = interrupted {
                return self
                    .emit(AgentEvent::Done {
                        status: DoneStatus::Interrupted,
                        error: None,
                        session_id: Some(SESSION_ID.into()),
                    })
                    .await;
            }
        }
        Ok(())
    }

    async fn ask(&mut self, turn: usize, question: UserInputQuestion) -> Result<Interrupted, Gone> {
        let request_id = format!("mock-q{turn}");
        self.emit(AgentEvent::InputRequested {
            request_id: request_id.clone(),
            questions: vec![question],
        })
        .await?;
        let answers = loop {
            match self.next_command().await {
                Some(RunCommand::Answer {
                    request_id: id,
                    answers,
                }) if id == request_id => break answers,
                Some(RunCommand::Send(prompt)) => self.queue.push_back(prompt),
                Some(RunCommand::Close) => self.closing = true,
                // Nobody left to answer.
                Some(RunCommand::Interrupt) | None => {
                    self.emit(AgentEvent::InputResolved { request_id }).await?;
                    return Ok(Interrupted::Yes);
                }
                Some(RunCommand::Answer { .. }) => {}
            }
        };
        self.emit(AgentEvent::InputResolved { request_id }).await?;
        let choice = answers
            .first()
            .and_then(|a: &UserInputAnswer| a.labels.first())
            .map_or("no answer".to_owned(), |l| format!("\"{l}\""));
        self.emit(AgentEvent::TextDelta {
            text: format!("Going with {choice}. "),
        })
        .await?;
        Ok(Interrupted::No)
    }

    /// Waits `ms` (scaled), handling commands that arrive meanwhile.
    async fn pause(&mut self, ms: u64) -> Interrupted {
        let deadline = Instant::now() + Duration::from_secs_f64(ms as f64 * self.speed / 1000.0);
        loop {
            tokio::select! {
                _ = tokio::time::sleep_until(deadline) => return Interrupted::No,
                command = self.commands.recv(), if self.commands_open => match command {
                    Some(RunCommand::Send(prompt)) => self.queue.push_back(prompt),
                    Some(RunCommand::Interrupt) => return Interrupted::Yes,
                    Some(RunCommand::Close) => self.closing = true,
                    Some(RunCommand::Answer { .. }) => {}
                    None => {
                        self.commands_open = false;
                        self.closing = true;
                    }
                },
            }
        }
    }

    async fn next_command(&mut self) -> Option<RunCommand> {
        if !self.commands_open {
            return None;
        }
        let command = self.commands.recv().await;
        self.commands_open = command.is_some();
        command
    }

    async fn emit(&self, event: AgentEvent) -> Result<(), Gone> {
        self.events.send(event).await.map_err(|_| Gone)
    }
}

fn script(request: &RunRequest, prompt: &str, turn: usize) -> Vec<Step> {
    let mut s = Script::default();
    // Tool ids are unique per session, like a real CLI's.
    let id = |name: &str| format!("{name}-{turn}");

    if turn == 0 {
        s.emit(
            0,
            AgentEvent::SessionStarted {
                harness: HarnessId::Mock,
                model: request.model.clone().unwrap_or_else(|| "mock-1".into()),
                cwd: request.cwd.clone(),
                session_id: SESSION_ID.into(),
                tools: vec!["Bash".into(), "Read".into(), "Edit".into(), "Task".into()],
            },
        );
        s.emit(
            0,
            AgentEvent::AvailableCommands {
                commands: vec![SlashCommand {
                    name: "review".into(),
                    description: "Review the current diff".into(),
                    input_hint: Some("focus area".into()),
                }],
            },
        );
    }
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
    // The same id on purpose: a known id refreshes in place, which is how a
    // live todo list updates.
    let plan = id("plan");
    s.tool(
        &plan,
        todo([Doing, Todo, Todo]),
        Some("Todos updated"),
        None,
        false,
    );

    s.text(&format!(
        "You asked: \"{}\". Let me start by reading the entry point.",
        prompt.trim()
    ));
    s.tool(
        &id("read"),
        ToolCall::ReadFile {
            path: "src/main.rs".into(),
        },
        Some("fn main() {\n    println!(\"hello\");\n}"),
        None,
        false,
    );
    s.tool(
        &plan,
        todo([Done, Doing, Todo]),
        Some("Todos updated"),
        None,
        false,
    );
    s.tool(
        &id("test"),
        ToolCall::Exec {
            command: "cargo test".into(),
        },
        Some("running 1 test\ntest smoke ... FAILED\n\nfailures:\n    smoke: assertion failed"),
        None,
        true,
    );
    s.text("One test fails. I'll have a subagent look into it while I search for related code.");

    let agent = id("agent");
    s.emit(
        250,
        AgentEvent::ToolCall {
            id: agent.clone(),
            call: ToolCall::Subagent {
                description: "Investigate failing smoke test".into(),
                model: Some("haiku".into()),
            },
        },
    );
    for text in ["Looking at ", "the smoke test", "…"] {
        s.emit(
            120,
            AgentEvent::Subagent {
                parent_tool_id: agent.clone(),
                event: Box::new(AgentEvent::TextDelta { text: text.into() }),
            },
        );
    }
    s.tool(
        &id("grep"),
        ToolCall::Search {
            pattern: "fn smoke".into(),
            path: Some("tests/".into()),
        },
        Some("tests/smoke.rs:3: fn smoke() {"),
        None,
        false,
    );
    s.emit(
        600,
        AgentEvent::Subagent {
            parent_tool_id: agent.clone(),
            event: Box::new(AgentEvent::Done {
                status: DoneStatus::Completed,
                error: None,
                session_id: None,
            }),
        },
    );
    s.emit(
        0,
        AgentEvent::ToolResult {
            id: agent,
            is_error: false,
            output: Some("The test expects `hello, world`.".into()),
            diff: None,
        },
    );

    s.0.push(Step::Ask(UserInputQuestion {
        id: "fix".into(),
        header: "Fix".into(),
        question: "Change the output or the test?".into(),
        options: vec!["Change the output".into(), "Change the test".into()],
        multi_select: false,
    }));

    s.tool(
        &id("edit"),
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
        &plan,
        todo([Done, Done, Done]),
        Some("Todos updated"),
        None,
        false,
    );
    s.emit(
        0,
        AgentEvent::ContextUsage {
            tokens: Some(48_200 + 9_000 * turn as u64),
            window: Some(200_000),
        },
    );
    s.text("Done. `main` now prints `hello, world`, which is what the smoke test expects.");
    s.emit(
        0,
        AgentEvent::Usage {
            input_tokens: 48_200,
            output_tokens: 1_310,
        },
    );
    s.emit(
        200,
        AgentEvent::Done {
            status: DoneStatus::Completed,
            error: None,
            session_id: Some(SESSION_ID.into()),
        },
    );
    s.0
}

#[derive(Default)]
struct Script(Vec<Step>);

impl Script {
    fn emit(&mut self, delay_ms: u64, event: AgentEvent) {
        self.0.push(Step::Emit(delay_ms, event));
    }

    /// Streams `text` a word at a time, like a model would.
    fn text(&mut self, text: &str) {
        for word in text.split_inclusive(' ') {
            self.emit(35, AgentEvent::TextDelta { text: word.into() });
        }
    }

    fn reasoning(&mut self, text: &str) {
        for word in text.split_inclusive(' ') {
            self.emit(20, AgentEvent::ReasoningDelta { text: word.into() });
        }
    }

    /// A tool call and its result.
    fn tool(
        &mut self,
        id: &str,
        call: ToolCall,
        output: Option<&str>,
        diff: Option<ToolDiff>,
        is_error: bool,
    ) {
        self.emit(
            250,
            AgentEvent::ToolCall {
                id: id.into(),
                call,
            },
        );
        self.emit(
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

#[cfg(test)]
mod tests {
    use super::*;
    use hive_proto::SandboxLevel;

    fn request() -> RunRequest {
        RunRequest {
            harness: HarnessId::Mock,
            prompt: "hi".into(),
            cwd: ".".into(),
            sandbox: SandboxLevel::WorkspaceWrite,
            model: None,
            reasoning: None,
            model_options: Default::default(),
            auto_approve: false,
            resume: None,
            attachments: Vec::new(),
        }
    }

    /// Collects events until one matches `stop`.
    async fn until(run: &mut Run, stop: impl Fn(&AgentEvent) -> bool) -> Vec<AgentEvent> {
        let mut seen = Vec::new();
        while let Some(event) = run.events.recv().await {
            let done = stop(&event);
            seen.push(event);
            if done {
                break;
            }
        }
        seen
    }

    #[tokio::test]
    async fn waits_for_the_answer_then_completes_and_takes_another_turn() {
        let mut run = MockHarness::with_speed(0.0).run(request()).unwrap();
        let seen = until(&mut run, |e| matches!(e, AgentEvent::InputRequested { .. })).await;
        assert!(matches!(seen[0], AgentEvent::SessionStarted { .. }));
        let Some(AgentEvent::InputRequested { request_id, .. }) = seen.last() else {
            unreachable!()
        };
        run.handle.answer(
            request_id.clone(),
            vec![UserInputAnswer {
                question_id: "fix".into(),
                labels: vec!["Change the test".into()],
            }],
        );
        let rest = until(&mut run, |e| matches!(e, AgentEvent::Done { .. })).await;
        assert!(rest.contains(&AgentEvent::TextDelta {
            text: "Going with \"Change the test\". ".into()
        }));
        assert!(matches!(
            rest.last(),
            Some(AgentEvent::Done {
                status: DoneStatus::Completed,
                ..
            })
        ));

        run.handle.send("again");
        run.handle.close();
        let second = until(&mut run, |e| matches!(e, AgentEvent::InputRequested { .. })).await;
        assert!(!second
            .iter()
            .any(|e| matches!(e, AgentEvent::SessionStarted { .. })));
    }

    #[tokio::test]
    async fn interrupt_ends_the_turn() {
        let mut run = MockHarness::new().run(request()).unwrap();
        run.events.recv().await;
        run.handle.interrupt();
        let seen = until(&mut run, |e| matches!(e, AgentEvent::Done { .. })).await;
        assert!(matches!(
            seen.last(),
            Some(AgentEvent::Done {
                status: DoneStatus::Interrupted,
                ..
            })
        ));
        drop(run.handle);
        assert!(run.events.recv().await.is_none());
    }
}
