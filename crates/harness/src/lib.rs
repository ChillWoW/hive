//! hive-harness — drives coding-agent CLIs and normalizes their output into
//! [`AgentEvent`]s.
//!
//! A [`Harness`] starts a [`Run`]: a live session that streams events and
//! takes follow-up commands through its [`RunHandle`]. Each turn ends with
//! [`AgentEvent::Done`]; the session stays open for the next prompt until the
//! handle is closed or dropped, and the event stream ends when the process
//! exits.

use hive_proto::{AgentEvent, HarnessId, RunRequest, UserInputAnswer};
use tokio::sync::mpsc;

pub mod claude;
pub mod mock;

pub use claude::ClaudeHarness;
pub use mock::MockHarness;

#[derive(Debug, thiserror::Error)]
pub enum HarnessError {
    #[error("{0} is not installed (not found on PATH)")]
    NotInstalled(&'static str),
    #[error("failed to start {0}: {1}")]
    Spawn(&'static str, std::io::Error),
}

pub trait Harness: Send + Sync {
    fn id(&self) -> HarnessId;

    /// Starts a session and sends `request.prompt` as its first turn. Must be
    /// called from inside a tokio runtime.
    fn run(&self, request: RunRequest) -> Result<Run, HarnessError>;
}

pub struct Run {
    pub events: mpsc::Receiver<AgentEvent>,
    pub handle: RunHandle,
}

/// Controls a live run. Clones share the run; when the last one is dropped
/// the session closes as if [`RunHandle::close`] were called.
#[derive(Clone)]
pub struct RunHandle {
    commands: mpsc::UnboundedSender<RunCommand>,
}

#[derive(Debug)]
pub(crate) enum RunCommand {
    Send(String),
    Answer {
        request_id: String,
        answers: Vec<UserInputAnswer>,
    },
    Interrupt,
    Close,
}

impl RunHandle {
    pub(crate) fn new() -> (Self, mpsc::UnboundedReceiver<RunCommand>) {
        let (commands, rx) = mpsc::unbounded_channel();
        (Self { commands }, rx)
    }

    /// Starts another turn with `prompt`. Sent mid-turn, the CLI takes it
    /// up once the current turn ends.
    pub fn send(&self, prompt: impl Into<String>) {
        let _ = self.commands.send(RunCommand::Send(prompt.into()));
    }

    /// Answers an [`AgentEvent::InputRequested`].
    pub fn answer(&self, request_id: impl Into<String>, answers: Vec<UserInputAnswer>) {
        let _ = self.commands.send(RunCommand::Answer {
            request_id: request_id.into(),
            answers,
        });
    }

    /// Stops the in-flight turn, which ends with `Done { status: interrupted }`.
    /// The session stays open.
    pub fn interrupt(&self) {
        let _ = self.commands.send(RunCommand::Interrupt);
    }

    /// Ends the session once the current turn finishes.
    pub fn close(&self) {
        let _ = self.commands.send(RunCommand::Close);
    }
}
