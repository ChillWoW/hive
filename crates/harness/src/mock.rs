//! A scripted harness: plays a canned turn through the real event types and
//! honors the same [`RunHandle`] commands as a real CLI, so the host and UI
//! can be built and tested without spending tokens.
//!
//! Every prompt plays the same turn. It stops at one question and waits for
//! [`RunHandle::answer`]; [`RunHandle::interrupt`] ends the turn early.
//! A prompt that mentions "background" plays a short turn instead that
//! leaves a dev server running (until stopped) and a subagent working for a
//! while, reported as [`AgentEvent::BackgroundTasks`].

use std::collections::VecDeque;
use std::time::Duration;

use hive_proto::{
    AccessMode, AgentEvent, BackgroundTask, BackgroundTaskKind, CommandKind, CompactionStatus,
    DoneStatus, FinishedTask, HarnessCapabilities, HarnessCatalog, HarnessId, Model,
    ReasoningLevel, RunRequest, SlashCommand, TaskEnd, TaskOutput, TodoItem, TodoStatus, ToolCall,
    ToolDiff, UserInputAnswer, UserInputQuestion,
};
use tokio::sync::mpsc;
use tokio::time::Instant;

use crate::{Harness, HarnessError, Run, RunCommand, RunHandle};

/// A command and a skill, for both menus.
fn commands() -> Vec<SlashCommand> {
    vec![
        SlashCommand {
            name: "compact".into(),
            description: "Summarize the conversation to free up context".into(),
            input_hint: None,
            kind: CommandKind::Command,
        },
        SlashCommand {
            name: "review".into(),
            description: "Review the current diff".into(),
            input_hint: Some("focus area".into()),
            kind: CommandKind::Command,
        },
        SlashCommand {
            name: "frontend-design".into(),
            description: "Distinctive, production-grade interfaces".into(),
            input_hint: None,
            kind: CommandKind::Skill,
        },
    ]
}

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
            commands: commands(),
            // A script can't ask before acting.
            access_modes: vec![AccessMode::FullAccess],
            capabilities: HarnessCapabilities {
                steering: false,
                interrupt: true,
                attachments: true,
                plan: false,
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
            background: Vec::new(),
        };
        tokio::spawn(player.run(request));
        Ok(Run { events, handle })
    }

    fn supports_titles(&self) -> bool {
        true
    }

    /// Title-cases the request's first four words, which the prompt's last
    /// line carries as a JSON string.
    fn run_title(&self, request: RunRequest) -> Result<Run, HarnessError> {
        let (events_tx, events) = mpsc::channel(8);
        let (handle, mut commands) = RunHandle::new();
        let asked = request
            .prompt
            .lines()
            .last()
            .and_then(|line| serde_json::from_str::<String>(line).ok())
            .unwrap_or_default();
        let title = asked
            .split_whitespace()
            .take(4)
            .map(|word| {
                let mut chars = word.chars();
                chars.next().map_or_else(String::new, |first| {
                    first.to_uppercase().chain(chars).collect()
                })
            })
            .collect::<Vec<_>>()
            .join(" ");
        let delay = Duration::from_secs_f64(0.4 * self.speed);
        tokio::spawn(async move {
            tokio::time::sleep(delay).await;
            for event in [
                AgentEvent::TextDelta { text: title },
                AgentEvent::Done {
                    status: DoneStatus::Completed,
                    error: None,
                    session_id: None,
                },
            ] {
                if events_tx.send(event).await.is_err() {
                    return;
                }
            }
            // Until closed, like a real session.
            while let Some(command) = commands.recv().await {
                if matches!(command, RunCommand::Close) {
                    return;
                }
            }
        });
        Ok(Run { events, handle })
    }
}

enum Step {
    /// Wait this many ms, then emit.
    Emit(u64, AgentEvent),
    /// Emit `InputRequested` and wait for the answer.
    Ask(UserInputQuestion),
    /// Leave this task running in the background; `None` runs until stopped,
    /// else it ends after that many ms (scaled).
    Background(BackgroundTask, Option<u64>),
}

/// A background task the mock keeps.
struct MockTask {
    task: BackgroundTask,
    started: Instant,
    ends: Option<Instant>,
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
    background: Vec<MockTask>,
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
            let expiry = self.next_expiry();
            let command = tokio::select! {
                command = self.next_command() => command,
                _ = sleep_until(expiry) => {
                    let Ok(ended) = self.expire().await else {
                        return false;
                    };
                    // Between turns, like the CLI: the model wakes on its own.
                    if !ended.is_empty() && self.play(wake_script(&ended), 0).await.is_err() {
                        return false;
                    }
                    continue;
                }
            };
            match command {
                Some(RunCommand::Send { prompt, .. }) => self.queue.push_back(prompt),
                Some(RunCommand::Close) | None => return false,
                Some(_) => {}
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
        self.play(script(request, prompt, turn), turn).await
    }

    async fn play(&mut self, steps: Vec<Step>, turn: usize) -> Result<(), Gone> {
        for step in steps {
            let interrupted = match step {
                Step::Emit(delay, event) => match self.pause(delay).await {
                    Interrupted::No => {
                        self.emit(event).await?;
                        Interrupted::No
                    }
                    yes => yes,
                },
                Step::Ask(question) => self.ask(turn, question).await?,
                Step::Background(task, lasts) => {
                    let started = Instant::now();
                    let ends = lasts.map(|ms| started + self.scaled(ms));
                    self.background.push(MockTask { task, started, ends });
                    self.report_background().await?;
                    Interrupted::No
                }
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
                Some(RunCommand::Send { prompt, .. }) => self.queue.push_back(prompt),
                Some(RunCommand::Close) => self.closing = true,
                // Nobody left to answer.
                Some(RunCommand::Interrupt) | None => {
                    self.emit(AgentEvent::InputResolved { request_id }).await?;
                    return Ok(Interrupted::Yes);
                }
                Some(_) => {}
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
        let deadline = Instant::now() + self.scaled(ms);
        loop {
            // Background tasks end between turns (`idle`), which keeps the
            // script deterministic: one that finishes wakes the model.
            tokio::select! {
                _ = tokio::time::sleep_until(deadline) => return Interrupted::No,
                command = self.next_command(), if self.commands_open => match command {
                    Some(RunCommand::Send { prompt, .. }) => self.queue.push_back(prompt),
                    Some(RunCommand::Interrupt) => return Interrupted::Yes,
                    Some(RunCommand::Close) => self.closing = true,
                    Some(_) => {}
                    None => self.closing = true,
                },
            }
        }
    }

    fn scaled(&self, ms: u64) -> Duration {
        Duration::from_secs_f64(ms as f64 * self.speed / 1000.0)
    }

    /// The next command for the turn; background-task commands are handled
    /// here, whatever the turn is doing.
    async fn next_command(&mut self) -> Option<RunCommand> {
        loop {
            if !self.commands_open {
                return None;
            }
            let command = self.commands.recv().await;
            self.commands_open = command.is_some();
            match command? {
                RunCommand::StopTask { task_id } => {
                    let Some(i) = self.background.iter().position(|t| t.task.id == task_id) else {
                        continue;
                    };
                    let task = self.background.remove(i).task;
                    if let (BackgroundTaskKind::Agent, Some(parent)) = (task.kind, task.tool_call_id) {
                        self.emit(subagent_done(parent, DoneStatus::Interrupted)).await.ok()?;
                    }
                    self.report_background().await.ok()?;
                }
                RunCommand::TaskOutput { task_id, reply } => {
                    let output = self
                        .background
                        .iter()
                        .find(|t| t.task.id == task_id && t.task.kind.has_output())
                        .map(|t| dev_server_log(t.started.elapsed()))
                        .ok_or_else(|| format!("No shell task {task_id}."));
                    let _ = reply.send(output);
                }
                command => return Some(command),
            }
        }
    }

    fn next_expiry(&self) -> Option<Instant> {
        self.background.iter().filter_map(|t| t.ends).min()
    }

    /// Ends the tasks whose time is up.
    /// Ends the tasks whose time is up, returning them.
    async fn expire(&mut self) -> Result<Vec<BackgroundTask>, Gone> {
        let now = Instant::now();
        let (ended, live): (Vec<_>, Vec<_>) = std::mem::take(&mut self.background)
            .into_iter()
            .partition(|t| t.ends.is_some_and(|at| at <= now));
        self.background = live;
        for task in &ended {
            if let (BackgroundTaskKind::Agent, Some(parent)) = (task.task.kind, &task.task.tool_call_id) {
                self.emit(subagent_done(parent.clone(), DoneStatus::Completed)).await?;
            }
        }
        self.report_background().await?;
        Ok(ended.into_iter().map(|t| t.task).collect())
    }

    async fn report_background(&self) -> Result<(), Gone> {
        let tasks = self.background.iter().map(|t| t.task.clone()).collect();
        self.emit(AgentEvent::BackgroundTasks { tasks }).await
    }

    async fn emit(&self, event: AgentEvent) -> Result<(), Gone> {
        self.events.send(event).await.map_err(|_| Gone)
    }
}

async fn sleep_until(deadline: Option<Instant>) {
    match deadline {
        Some(at) => tokio::time::sleep_until(at).await,
        None => std::future::pending().await,
    }
}

fn subagent_done(parent_tool_id: String, status: DoneStatus) -> AgentEvent {
    AgentEvent::Subagent {
        parent_tool_id,
        event: Box::new(AgentEvent::Done {
            status,
            error: None,
            session_id: None,
        }),
    }
}

/// What the mock dev server has printed after running `elapsed`.
fn dev_server_log(elapsed: Duration) -> TaskOutput {
    let mut output = String::from(
        "$ bun run dev\n\n  VITE v6.3.5  ready in 312 ms\n\n  \u{279c}  Local:   http://localhost:1421/\n  \u{279c}  Network: use --host to expose\n",
    );
    for i in 0..elapsed.as_secs() / 3 {
        let file = ["src/App.tsx", "src/chat/ChatView.tsx", "src/index.css"][i as usize % 3];
        output.push_str(&format!("[vite] hmr update /{file}\n"));
    }
    TaskOutput {
        total_bytes: output.len() as u64,
        output,
        truncated: false,
    }
}

/// The turn the model starts on its own once `ended` finished.
fn wake_script(ended: &[BackgroundTask]) -> Vec<Step> {
    let mut s = Script::default();
    s.emit(
        0,
        AgentEvent::BackgroundTurn {
            finished: ended
                .iter()
                .map(|t| FinishedTask {
                    description: t.description.clone(),
                    status: TaskEnd::Completed,
                })
                .collect(),
        },
    );
    s.text("The survey is back: a Vite + React frontend in `src/`, a Rust backend under `crates/`, and the Tauri shell in `src-tauri/`. The dev server is still running.");
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

/// `/compact`: a compaction that takes a moment, then the smaller context.
fn compact_script() -> Vec<Step> {
    let mut s = Script::default();
    let compaction = |status, after| AgentEvent::Compaction {
        status,
        auto: false,
        before_tokens: Some(48_200),
        after_tokens: after,
        error: None,
    };
    s.emit(0, compaction(CompactionStatus::Running, None));
    s.emit(1800, compaction(CompactionStatus::Completed, Some(6_400)));
    s.emit(
        0,
        AgentEvent::ContextUsage {
            tokens: Some(6_400),
            window: None,
        },
    );
    s.emit(
        100,
        AgentEvent::Done {
            status: DoneStatus::Completed,
            error: None,
            session_id: Some(SESSION_ID.into()),
        },
    );
    s.0
}

/// A turn that leaves a dev server and a subagent running in the background.
fn background_script(turn: usize) -> Vec<Step> {
    let mut s = Script::default();
    let (shell, agent) = (format!("bg-shell-{turn}"), format!("bg-agent-{turn}"));
    s.text("Starting the dev server in the background, and sending an agent to look around meanwhile.");
    s.tool(
        &shell,
        ToolCall::Exec {
            command: "bun run dev".into(),
        },
        Some("Command running in background."),
        None,
        false,
    );
    s.0.push(Step::Background(
        BackgroundTask {
            id: format!("mock-shell-{turn}"),
            kind: BackgroundTaskKind::Shell,
            description: "Start the dev server".into(),
            tool_call_id: Some(shell),
            parent_id: None,
            agent_type: None,
            started_at: None,
        },
        None,
    ));
    s.emit(
        250,
        AgentEvent::ToolCall {
            id: agent.clone(),
            call: ToolCall::Subagent {
                description: "Survey the codebase".into(),
                model: None,
            },
        },
    );
    s.emit(
        300,
        AgentEvent::ToolResult {
            id: agent.clone(),
            is_error: false,
            output: Some("Async agent launched in the background.".into()),
            diff: None,
        },
    );
    s.0.push(Step::Background(
        BackgroundTask {
            id: format!("mock-agent-{turn}"),
            kind: BackgroundTaskKind::Agent,
            description: "Survey the codebase".into(),
            tool_call_id: Some(agent),
            parent_id: None,
            agent_type: Some("general-purpose".into()),
            started_at: None,
        },
        Some(15_000),
    ));
    s.text(" Both are running; I'll pick up where they leave off.");
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
                commands: commands(),
            },
        );
    }
    if prompt.to_lowercase().contains("background") {
        s.0.extend(background_script(turn));
        return s.0;
    }
    if prompt.trim() == "/compact" {
        s.0.extend(compact_script());
        return s.0;
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
            access: Default::default(),
            plan: false,
            resume: None,
            attachments: Vec::new(),
            mcp: None,
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
