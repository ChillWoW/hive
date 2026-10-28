//! What a harness offers, as the composer's pickers show it.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::agent::{HarnessId, Model, SandboxLevel, SlashCommand};

/// A harness's models, commands and capabilities, from
/// `Harness::catalog`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct HarnessCatalog {
    pub id: HarnessId,
    pub label: String,
    /// The CLI was found; a chat on a harness that isn't fails its first send.
    pub installed: bool,
    /// Best first.
    pub models: Vec<Model>,
    /// What a chat with no model picked runs on; one of `models`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_model: Option<String>,
    /// Built-in slash commands. A live session reports its own full list
    /// (`Session::commands`), which includes the user's.
    pub commands: Vec<SlashCommand>,
    /// Best-supported first; the first is the default.
    pub sandbox_levels: Vec<SandboxLevel>,
    pub capabilities: HarnessCapabilities,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct HarnessCapabilities {
    /// A prompt sent mid-turn reaches the running turn. Without it the
    /// prompt waits for the turn to end.
    pub steering: bool,
    /// The running turn can be stopped.
    pub interrupt: bool,
    /// Images can ride along with a prompt.
    pub attachments: bool,
}
