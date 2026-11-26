//! Chats, and the updates their watchers get.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::agent::{AgentEvent, BackgroundTask, SlashCommand};
use crate::message::{Attachment, Message};
use crate::model::ChatConfig;

/// A conversation with an agent in one folder.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct Chat {
    pub id: String,
    /// The user's name for it; untitled until renamed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// The project folder: where the agent works, unless the chat has a
    /// worktree ([`Chat::work_dir`]).
    pub cwd: String,
    /// The model and effort its turns run on.
    #[serde(default)]
    pub config: ChatConfig,
    /// The CLI's own session id, resumed by the next run so the agent keeps
    /// the conversation (`RunRequest::resume`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// Listed under the sidebar's Archived section; a new turn brings it back.
    #[serde(default)]
    pub archived: bool,
    /// Epoch millis of the pin; pinned chats are listed first, in pin order.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pinned_at: Option<i64>,
    /// Epoch millis.
    pub created_at: i64,
    /// Epoch millis of the latest prompt or reply.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_message_at: Option<i64>,
    /// The git worktree the chat works in, made for it when it was created;
    /// missing for a chat in `cwd`'s own checkout.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree: Option<Worktree>,
}

impl Chat {
    /// Where the agent runs: the worktree's folder, else `cwd`.
    pub fn work_dir(&self) -> &str {
        self.worktree.as_ref().map_or(&self.cwd, |w| &w.path)
    }
}

/// A git worktree Outcode made for one chat: a checkout of its own branch in
/// a folder of its own, so the agent's work doesn't touch the project's
/// checkout. Removed with the chat; the branch is kept unless
/// `worktrees.deleteBranch` is on.
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

/// Asks `chat_create` for a worktree.
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

/// How far `chat_create` got making a chat's worktree, streamed while it
/// works; the chat it returns has the result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "step", rename_all = "camelCase")]
pub enum WorktreeStep {
    /// A text run is naming the branch (semantic naming).
    Naming,
    /// `git worktree add` is checking the branch out; `branch` is the name
    /// asked for (numbered if it turns out taken).
    CheckingOut { branch: String },
}

/// A prompt sent while the chat's turn was running, waiting its turn.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct QueuedPrompt {
    pub id: String,
    pub prompt: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[ts(as = "Option<Vec<Attachment>>")]
    pub attachments: Vec<Attachment>,
}

/// How full a chat's context window is, as last reported.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct ContextWindow {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window: Option<u64>,
}

/// A chat's live state beside its transcript: never saved, rebuilt as its
/// agent runs.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct Session {
    pub chat_id: String,
    /// A turn is running.
    pub working: bool,
    /// Prompts waiting for the running turn to end, first to go first.
    pub queued: Vec<QueuedPrompt>,
    /// The user stopped the last turn: the queue waits until a turn they
    /// start ends (or one is sent now).
    pub held: bool,
    /// Work the agent left running in the background.
    pub tasks: Vec<BackgroundTask>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<ContextWindow>,
    /// Secrets the agent asked for (`request_secret`), waiting on the user.
    #[serde(default)]
    pub secrets: Vec<SecretRequest>,
    /// The commands and skills the agent last listed.
    pub commands: Vec<SlashCommand>,
}

impl Session {
    pub fn new(chat_id: impl Into<String>) -> Self {
        Self {
            chat_id: chat_id.into(),
            ..Self::default()
        }
    }

    /// Nothing worth keeping: no turn, queue, tasks or reports.
    pub fn is_blank(&self) -> bool {
        !self.working
            && self.queued.is_empty()
            && self.tasks.is_empty()
            && self.context.is_none()
            && self.commands.is_empty()
            && self.secrets.is_empty()
    }
}

/// A secret the agent asked the user for. What the user types goes to a
/// private file, never into the chat; the agent gets its path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct SecretRequest {
    pub id: String,
    /// What it is ("Tailscale auth key").
    pub label: String,
    /// What it's for and where to get it.
    pub reason: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub placeholder: Option<String>,
}

/// What a `watch_chats` watcher hears: every chat once, then each change.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ChatsUpdate {
    /// Every chat, most recently active first, and the live sessions.
    Snapshot { chats: Vec<Chat>, sessions: Vec<Session> },
    /// A chat created or changed.
    Upsert { chat: Chat },
    Removed { id: String },
    /// A chat's live state changed.
    Session { session: Session },
}


/// What a `watch_messages` watcher hears about one chat: its messages once,
/// then each change.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum MessagesUpdate {
    /// Every message, oldest first; a reply being written as far as it got.
    Snapshot { messages: Vec<Message> },
    /// A message added, or a reply settled (its status and duration set).
    Upsert { message: Message },
    /// An event the streaming reply `message_id` folds in (`fold_event`).
    Event { message_id: String, event: AgentEvent },
}
