//! A scripted harness for tests (feature `mock`): each turn plays the
//! [`Step`]s its script gives it, served over the same [`RunHandle`]
//! commands a CLI's run takes.
//!
//! - A turn ends at the first top-level [`AgentEvent::Done`] it emits, else
//!   with `Done { completed }` after its last step.
//! - Commands are taken as a turn waits ([`Step::Wait`], [`Step::Ask`]) and
//!   between turns; steps that only emit play straight through.
//! - An interrupt ends a waiting turn with `Done { interrupted }`; a
//!   question it waited on resolves unanswered first. Between turns it does
//!   nothing.
//! - A prompt sent mid-turn waits for the turn to end, as a CLI's does.
//! - Close ends the run once the turn in flight ends; dropping every handle
//!   ends it at once.
//! - Every run request, command and text prompt is kept in [`Seen`].

use std::collections::VecDeque;
use std::sync::{Arc, Mutex, PoisonError};

use outcode_proto::{AgentEvent, Catalog, DoneStatus, InputRequest, InputResponse, RunRequest, SlashCommand};
use tokio::sync::mpsc;

use crate::{BoxFuture, Gone, Harness, HarnessError, Run, RunCommand, RunHandle};

/// A turn, as a script sees it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Turn {
    /// Which run it's in, counting from 1 in the order they started (0 for
    /// text runs).
    pub run: usize,
    /// Which turn of its run, counting from 1.
    pub turn: usize,
    pub prompt: String,
}

/// One step of a scripted turn.
#[derive(Debug, Clone)]
pub enum Step {
    Emit(AgentEvent),
    /// Waits for the next answer, whatever it's to (an approval the test
    /// stands in for, a tool call to finish).
    Wait,
    /// Asks `request`, waits for its answer, and reports it resolved.
    Ask { request_id: String, request: InputRequest },
}

impl Step {
    pub fn text(text: impl Into<String>) -> Self {
        Self::Emit(AgentEvent::TextDelta { text: text.into() })
    }
}

type Script = Arc<dyn Fn(&Turn) -> Vec<Step> + Send + Sync>;

/// The default script: each turn answers `echo: <prompt>`, the first of a
/// run as session `s<run>`.
pub fn echo(turn: &Turn) -> Vec<Step> {
    let mut steps = Vec::new();
    if turn.turn == 1 {
        steps.push(Step::Emit(AgentEvent::SessionStarted {
            session_id: format!("s{}", turn.run),
        }));
    }
    steps.push(Step::text(format!("echo: {}", turn.prompt)));
    steps
}

pub struct Mock {
    script: Script,
    text: Option<String>,
    fail: Option<Box<dyn Fn() -> HarnessError + Send + Sync>>,
    seen: Arc<Seen>,
}

impl Default for Mock {
    fn default() -> Self {
        Self::new()
    }
}

impl Mock {
    /// Runs [`echo`]; text runs fail.
    pub fn new() -> Self {
        Self {
            script: Arc::new(echo),
            text: None,
            fail: None,
            seen: Arc::default(),
        }
    }

    /// Plays `script`'s steps for each turn.
    pub fn script(mut self, script: impl Fn(&Turn) -> Vec<Step> + Send + Sync + 'static) -> Self {
        self.script = Arc::new(script);
        self
    }

    /// Text runs answer `answer`.
    pub fn text(mut self, answer: impl Into<String>) -> Self {
        self.text = Some(answer.into());
        self
    }

    /// Runs fail to start, with `error`'s error.
    pub fn failing(mut self, error: impl Fn() -> HarnessError + Send + Sync + 'static) -> Self {
        self.fail = Some(Box::new(error));
        self
    }

    /// What it has been asked, so far and from here on.
    pub fn seen(&self) -> Arc<Seen> {
        self.seen.clone()
    }
}

/// What a [`Mock`] was asked.
#[derive(Default)]
pub struct Seen {
    runs: Mutex<Vec<RunRequest>>,
    commands: Mutex<Vec<RunCommand>>,
    texts: Mutex<Vec<String>>,
}

impl Seen {
    /// The runs started, oldest first.
    pub fn runs(&self) -> Vec<RunRequest> {
        lock(&self.runs).clone()
    }

    /// Commands sent to chats' runs (not text runs), oldest first.
    pub fn commands(&self) -> Vec<RunCommand> {
        lock(&self.commands).clone()
    }

    /// Text runs' prompts, oldest first.
    pub fn texts(&self) -> Vec<String> {
        lock(&self.texts).clone()
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl Harness for Mock {
    fn id(&self) -> &'static str {
        "mock"
    }

    fn catalog(&self) -> Catalog {
        Catalog {
            installed: true,
            models: Vec::new(),
            default_model: None,
        }
    }

    fn run(&self, request: RunRequest) -> Result<Run, HarnessError> {
        if let Some(error) = &self.fail {
            return Err(error());
        }
        let prompt = request.prompt.clone();
        let run = {
            let mut runs = lock(&self.seen.runs);
            runs.push(request);
            runs.len()
        };
        Ok(start(self.script.clone(), run, prompt, Some(self.seen.clone())))
    }

    fn run_text(&self, prompt: String, _model: Option<&str>) -> Result<Run, HarnessError> {
        if let Some(error) = &self.fail {
            return Err(error());
        }
        lock(&self.seen.texts).push(prompt.clone());
        let answer = self
            .text
            .clone()
            .ok_or_else(|| HarnessError::Probe("the mock has no text runs".into()))?;
        let script: Script = Arc::new(move |_| vec![Step::text(answer.clone())]);
        Ok(start(script, 0, prompt, None))
    }

    fn commands<'a>(&'a self, _cwd: &'a str) -> BoxFuture<'a, Result<Vec<SlashCommand>, HarnessError>> {
        Box::pin(async { Ok(Vec::new()) })
    }
}

fn start(script: Script, run: usize, prompt: String, seen: Option<Arc<Seen>>) -> Run {
    let (handle, commands) = RunHandle::new();
    let (tx, events) = mpsc::channel(64);
    let driver = Driver {
        script,
        run,
        tx,
        commands,
        seen,
        queue: VecDeque::from([prompt]),
        closing: false,
    };
    tokio::spawn(driver.drive());
    Run { events, handle }
}

struct Driver {
    script: Script,
    run: usize,
    tx: mpsc::Sender<AgentEvent>,
    commands: mpsc::UnboundedReceiver<RunCommand>,
    /// Where commands are kept; none for text runs.
    seen: Option<Arc<Seen>>,
    /// Prompts waiting for their turn.
    queue: VecDeque<String>,
    closing: bool,
}

const INTERRUPTED: AgentEvent = AgentEvent::Done {
    status: DoneStatus::Interrupted,
};

impl Driver {
    async fn drive(mut self) {
        let mut turns = 0;
        loop {
            if let Some(prompt) = self.queue.pop_front() {
                turns += 1;
                let turn = Turn {
                    run: self.run,
                    turn: turns,
                    prompt,
                };
                if self.play(&turn).await.is_err() {
                    return;
                }
            } else if self.closing {
                return;
            } else {
                match self.commands.recv().await {
                    Some(command) => self.note(&command),
                    None => return,
                }
            }
        }
    }

    /// Keeps `command`, and queues a prompt or a close; what else it means
    /// is up to the caller.
    fn note(&mut self, command: &RunCommand) {
        if let Some(seen) = &self.seen {
            lock(&seen.commands).push(command.clone());
        }
        match command {
            RunCommand::Send { prompt, .. } => self.queue.push_back(prompt.clone()),
            RunCommand::Close => self.closing = true,
            _ => {}
        }
    }

    async fn emit(&self, event: AgentEvent) -> Result<(), Gone> {
        self.tx.send(event).await.map_err(|_| Gone)
    }

    /// Plays `turn`'s steps until it ends.
    async fn play(&mut self, turn: &Turn) -> Result<(), Gone> {
        for step in (self.script)(turn) {
            match step {
                Step::Emit(event) => {
                    let done = matches!(event, AgentEvent::Done { .. });
                    self.emit(event).await?;
                    if done {
                        return Ok(());
                    }
                }
                Step::Wait => {
                    if self.wait(None).await?.is_none() {
                        return self.emit(INTERRUPTED).await;
                    }
                }
                Step::Ask { request_id, request } => {
                    let asked = AgentEvent::InputRequested {
                        request_id: request_id.clone(),
                        request,
                    };
                    self.emit(asked).await?;
                    let response = self.wait(Some(&request_id)).await?;
                    let interrupted = response.is_none();
                    self.emit(AgentEvent::InputResolved { request_id, response }).await?;
                    if interrupted {
                        return self.emit(INTERRUPTED).await;
                    }
                }
            }
        }
        self.emit(AgentEvent::Done {
            status: DoneStatus::Completed,
        })
        .await
    }

    /// Waits for an answer to `request_id` (any, when `None`); `None` when
    /// the turn is interrupted first.
    async fn wait(&mut self, request_id: Option<&str>) -> Result<Option<InputResponse>, Gone> {
        loop {
            let command = self.commands.recv().await.ok_or(Gone)?;
            self.note(&command);
            match command {
                RunCommand::Interrupt => return Ok(None),
                RunCommand::Answer { request_id: id, response } if request_id.is_none_or(|r| r == id) => {
                    return Ok(Some(response));
                }
                _ => {}
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use outcode_proto::{ApprovalDecision, InputRequest};

    use super::*;

    /// The run's events until its turn ends.
    async fn turn(run: &mut Run) -> Vec<AgentEvent> {
        let mut events = Vec::new();
        loop {
            let event = tokio::time::timeout(Duration::from_secs(5), run.events.recv())
                .await
                .expect("the turn ended")
                .expect("the run is up");
            let done = matches!(event, AgentEvent::Done { .. });
            events.push(event);
            if done {
                return events;
            }
        }
    }

    fn request(prompt: &str) -> RunRequest {
        RunRequest {
            prompt: prompt.into(),
            ..RunRequest::default()
        }
    }

    fn done(status: DoneStatus) -> AgentEvent {
        AgentEvent::Done { status }
    }

    fn text(text: &str) -> AgentEvent {
        AgentEvent::TextDelta { text: text.into() }
    }

    fn allow() -> InputResponse {
        InputResponse::Approval {
            decision: ApprovalDecision::Allow,
        }
    }

    #[tokio::test]
    async fn turns_echo_and_a_close_ends_the_run() {
        let mock = Mock::new();
        let mut run = mock.run(request("hi")).unwrap();
        let session = AgentEvent::SessionStarted { session_id: "s1".into() };
        assert_eq!(turn(&mut run).await, [session, text("echo: hi"), done(DoneStatus::Completed)]);
        run.handle.send("again", Vec::new());
        assert_eq!(turn(&mut run).await, [text("echo: again"), done(DoneStatus::Completed)]);
        run.handle.close();
        assert_eq!(run.events.recv().await, None);
        assert_eq!(mock.seen().runs()[0].prompt, "hi");
    }

    #[tokio::test]
    async fn a_question_waits_for_its_answer() {
        let request_id = "q1".to_owned();
        let ask = Step::Ask {
            request_id: request_id.clone(),
            request: InputRequest::Plan { plan: "p".into() },
        };
        let mock = Mock::new().script(move |_| vec![ask.clone(), Step::text("after")]);
        let mut run = mock.run(request("go")).unwrap();
        assert!(matches!(run.events.recv().await, Some(AgentEvent::InputRequested { .. })));
        // An answer to another request doesn't count.
        run.handle.answer("other", allow());
        run.handle.answer(&request_id, allow());
        assert_eq!(
            turn(&mut run).await,
            [
                AgentEvent::InputResolved {
                    request_id,
                    response: Some(allow())
                },
                text("after"),
                done(DoneStatus::Completed)
            ]
        );
    }

    #[tokio::test]
    async fn an_interrupt_ends_the_turn_and_a_prompt_sent_meanwhile_goes_next() {
        let mock = Mock::new().script(|turn| match turn.turn {
            1 => vec![Step::Wait, Step::text("never")],
            _ => echo(turn),
        });
        let mut run = mock.run(request("one")).unwrap();
        run.handle.send("two", Vec::new());
        run.handle.interrupt();
        assert_eq!(turn(&mut run).await, [done(DoneStatus::Interrupted)]);
        assert_eq!(turn(&mut run).await, [text("echo: two"), done(DoneStatus::Completed)]);
        assert!(mock.seen().commands().contains(&RunCommand::Interrupt));
    }

    #[tokio::test]
    async fn text_runs_answer_and_failing_runs_dont_start() {
        let mock = Mock::new().text("Title");
        let mut run = mock.run_text("name it".into(), None).unwrap();
        assert_eq!(turn(&mut run).await, [text("Title"), done(DoneStatus::Completed)]);
        assert_eq!(mock.seen().texts(), ["name it"]);
        assert!(mock.seen().runs().is_empty());

        let broken = Mock::new().failing(|| HarnessError::NotInstalled("mock"));
        assert!(matches!(broken.run(request("hi")), Err(HarnessError::NotInstalled("mock"))));
    }
}
