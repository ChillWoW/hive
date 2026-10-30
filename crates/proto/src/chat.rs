//! Chats and their live sessions.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::agent::{
    AccessMode, BackgroundTask, Goal, HarnessId, ReasoningLevel, SandboxLevel, SlashCommand,
};

/// The run settings a chat sends with each turn; the composer edits these.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ChatConfig {
    pub harness: HarnessId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<ReasoningLevel>,
    #[serde(default)]
    pub model_options: BTreeMap<String, String>,
    pub sandbox: SandboxLevel,
    /// What the agent may do without asking; chats from before access modes
    /// read as full access, which is how they ran.
    #[serde(default)]
    pub access: AccessMode,
    /// Plan mode, kept on the chat until turned off: each turn starts in it.
    #[serde(default)]
    pub plan: bool,
}

/// A conversation with one harness in one working directory.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct Chat {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub cwd: String,
    pub config: ChatConfig,
    /// Harness-native session id of the latest run, sent back as
    /// `RunRequest::resume` so the CLI keeps its own history.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub harness_session_id: Option<String>,
    /// Listed under the sidebar's Archived section; a new turn brings it back.
    #[serde(default)]
    pub archived: bool,
    /// Epoch millis of the pin; pinned chats are listed first, in pin order.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pinned_at: Option<i64>,
    /// Epoch millis.
    pub created_at: i64,
    /// Epoch millis.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_message_at: Option<i64>,
    /// Epoch millis; compared with `last_message_at` for the unread dot.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_seen_at: Option<i64>,
    /// Latest context-window occupancy; outlives the run.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<ContextUsage>,
    /// The git worktree the chat works in, made for it when it was created;
    /// missing for a chat in `cwd`'s own checkout.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree: Option<Worktree>,
}

/// A git worktree Hive made for one chat: a checkout of its own branch in a
/// folder of its own, so the agent's work doesn't touch the project's
/// checkout. Removed with the chat; the branch is kept.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Worktree {
    /// The worktree's top folder.
    pub root: String,
    /// Where the agent runs: `root`, or the same subfolder of it that the
    /// chat's `cwd` is of its repository.
    pub path: String,
    /// The branch checked out in it, made for it.
    pub branch: String,
    /// What the branch was made from: a branch name or a commit.
    pub base: String,
}

/// Asks `create_chat` for a worktree.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct NewWorktree {
    /// The branch or commit to start from; the checked-out one when missing.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base: Option<String>,
    /// Text to name the branch after (the first prompt).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
}

impl Chat {
    /// Where the agent runs: the worktree's folder, else `cwd`.
    pub fn work_dir(&self) -> &str {
        self.worktree.as_ref().map_or(&self.cwd, |w| &w.path)
    }

    /// The chat has activity the user hasn't opened yet.
    pub fn unseen(&self) -> bool {
        match (self.last_message_at, self.last_seen_at) {
            (Some(msg), Some(seen)) => msg > seen,
            (Some(_), None) => true,
            (None, _) => false,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum SessionStatus {
    Idle,
    Working,
    AwaitingInput,
    Errored,
}

/// The live run state of a chat, while its harness process exists.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct Session {
    pub chat_id: String,
    pub status: SessionStatus,
    /// Epoch millis.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<i64>,
    /// Epoch millis.
    pub updated_at: i64,
    /// Slash commands the session reported, the user's own included.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[ts(as = "Option<Vec<SlashCommand>>")]
    pub commands: Vec<SlashCommand>,
    /// Background tasks running now; the run stays open while there are any.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[ts(as = "Option<Vec<BackgroundTask>>")]
    pub background: Vec<BackgroundTask>,
    /// Secrets the agent is waiting on (Hive's `request_secret` tool), oldest
    /// first. Only what the card shows; the value never passes through here.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[ts(as = "Option<Vec<SecretRequest>>")]
    pub secrets: Vec<SecretRequest>,
    /// The goal the agent keeps working toward (Codex's `/goal`), while one
    /// is set.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub goal: Option<Goal>,
}

/// An agent asking the user for a secret (an API key, a token) in a card
/// of its own, so the value stays out of the chat.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct SecretRequest {
    pub id: String,
    /// The card's title, e.g. "GitHub token".
    pub label: String,
    /// What it's for and where to get it.
    pub reason: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub placeholder: Option<String>,
    /// Epoch millis.
    pub requested_at: i64,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ContextUsage {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window: Option<u64>,
}

impl ContextUsage {
    pub fn fraction(self) -> Option<f64> {
        Some(self.tokens? as f64 / self.window.filter(|n| *n > 0)? as f64)
    }
}
