//! Models, their reasoning levels and options, and what a chat runs on.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::agent::AccessMode;

/// How hard a model thinks before answering (Claude's `--effort`, Codex's
/// reasoning effort).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum ReasoningLevel {
    Low,
    Medium,
    High,
    XHigh,
    Max,
}

/// A model a harness can run.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct Model {
    pub id: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Lowest first; empty for a model that doesn't take an effort.
    #[serde(default)]
    pub reasoning_levels: Vec<ReasoningLevel>,
    /// Knobs beyond reasoning (Claude's fast mode).
    #[serde(default)]
    pub options: Vec<ModelOption>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ModelOption {
    pub id: String,
    pub label: String,
    pub choices: Vec<ModelOptionChoice>,
    pub default_choice: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ModelOptionChoice {
    pub id: String,
    pub label: String,
}

/// What a harness offers.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct Catalog {
    /// Its CLI was found.
    pub installed: bool,
    /// Newest and most used first.
    pub models: Vec<Model>,
    /// What runs when a chat picks none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_model: Option<String>,
}

/// A coding-agent CLI a chat runs on.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum HarnessId {
    #[default]
    Claude,
    Codex,
    /// Google's Antigravity CLI (`agy`).
    Antigravity,
}

impl HarnessId {
    pub const ALL: [HarnessId; 3] = [HarnessId::Claude, HarnessId::Codex, HarnessId::Antigravity];

    /// The CLI's name, as its binary is called.
    pub fn as_str(self) -> &'static str {
        match self {
            HarnessId::Claude => "claude",
            HarnessId::Codex => "codex",
            HarnessId::Antigravity => "agy",
        }
    }
}

/// What a chat runs on; the composer's model picker edits it. Unset fields
/// leave the choice to the CLI.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ChatConfig {
    /// The CLI it runs on. Switching starts a new session there.
    #[serde(default)]
    pub harness: HarnessId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<ReasoningLevel>,
    /// Selections for [`Model::options`]: option id → choice id.
    #[serde(default)]
    pub model_options: BTreeMap<String, String>,
    /// What the agent may do without asking. Changes apply to a live run at
    /// once.
    #[serde(default)]
    pub access: AccessMode,
    /// Plan mode: each turn explores and proposes a plan instead of changing
    /// anything; approving the plan lets that turn implement it.
    #[serde(default)]
    pub plan: bool,
}

impl ChatConfig {
    /// The same config but for access and plan mode, which a live run
    /// takes without restarting.
    pub fn same_launch(&self, other: &ChatConfig) -> bool {
        self.harness == other.harness
            && self.model == other.model
            && self.reasoning == other.reasoning
            && self.model_options == other.model_options
    }
}

impl ChatConfig {
    /// The option for Claude's fast mode, on models that offer it.
    pub const FAST_MODE: &str = "fastMode";

    /// Whether fast mode is picked.
    pub fn fast_mode(&self) -> bool {
        self.model_options.get(Self::FAST_MODE).map(String::as_str) == Some("on")
    }
}
