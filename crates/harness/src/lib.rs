//! outcode-harness — drives coding-agent CLIs and normalizes their output
//! into [`AgentEvent`]s.

use outcode_proto::AgentEvent;
use tokio::sync::mpsc;

pub mod claude;
mod cli;

#[derive(Debug, thiserror::Error)]
pub enum HarnessError {
    #[error("{0} is not installed (not found on PATH)")]
    NotInstalled(&'static str),
    #[error("{0} doesn't exist")]
    BinaryMissing(String),
    #[error("failed to start {0}: {1}")]
    Spawn(&'static str, std::io::Error),
}

/// A started run: its events end with [`AgentEvent::Done`], then the stream
/// closes. Dropping the receiver tears the run down.
pub struct Run {
    pub events: mpsc::Receiver<AgentEvent>,
}
