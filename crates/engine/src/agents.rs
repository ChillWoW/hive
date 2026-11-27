//! Agents running agents: a chat's agent starts chats of its own (Outcode's
//! `start_chat` tool), its children. A child is an ordinary chat the user
//! can open, answer and stop; it runs in its parent's folder and worktree
//! with the parent's access and plan mode, and can't start chats itself.
//! The parent hears back only how a child stands and its latest reply, not
//! its transcript.

use std::collections::BTreeSet;
use std::time::Duration;

use outcode_proto::{Chat, ChatConfig, ChatsUpdate, HarnessId, Message, MessagePart, MessageRole, MessageStatus, ReasoningLevel};
use tokio::sync::mpsc;

use crate::{Engine, EngineError, Result};

/// Children of one chat working at once.
pub const MAX_WORKING_CHILDREN: usize = 8;
/// Longest reply text a status carries.
const MAX_REPLY_CHARS: usize = 30_000;

/// What a child runs on; unset fields follow the parent when it's on the
/// same harness, else the CLI's defaults.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ChildAgent {
    pub harness: HarnessId,
    pub model: Option<String>,
    pub reasoning: Option<ReasoningLevel>,
}

/// Where a child stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChildState {
    /// A turn runs, or its prompt waits to go.
    Working,
    /// Its turn waits on the user: an approval, a question, a secret.
    WaitingOnUser,
    /// Between turns: its latest reply is final.
    Idle,
}

impl ChildState {
    pub fn as_str(self) -> &'static str {
        match self {
            ChildState::Working => "working",
            ChildState::WaitingOnUser => "waitingOnUser",
            ChildState::Idle => "idle",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ChildStatus {
    pub chat: Chat,
    pub state: ChildState,
    /// The latest reply's closing text (after its last tool call), as far
    /// as it got.
    pub reply: Option<String>,
    /// The latest reply's last error.
    pub error: Option<String>,
    /// The user (or the parent) stopped the latest reply.
    pub stopped: bool,
    /// Prompts waiting for the running turn.
    pub queued: usize,
    /// What the turn waits on the user for, by request id.
    pending: BTreeSet<String>,
}

impl Engine {
    /// Starts a child of `parent_id` on `agent`, with `prompt` as its first
    /// turn; returns at once. Refused for a chat that's a child itself, and
    /// while [`MAX_WORKING_CHILDREN`] of its children work. Must be called
    /// inside a tokio runtime.
    pub fn start_child(&self, parent_id: &str, agent: ChildAgent, title: Option<String>, prompt: String) -> Result<Chat> {
        let parent = self
            .store()
            .chat(parent_id)?
            .ok_or_else(|| EngineError::NotFound(parent_id.into()))?;
        if parent.parent_chat_id.is_some() {
            return Err(EngineError::Nested);
        }
        if prompt.trim().is_empty() {
            return Err(EngineError::EmptyPrompt);
        }
        let working = {
            let state = self.state();
            self.children(parent_id)?.iter().filter(|c| state.working(&c.id)).count()
        };
        if working >= MAX_WORKING_CHILDREN {
            return Err(EngineError::TooManyChildren(MAX_WORKING_CHILDREN));
        }
        let mut chat = self.store().create_chat(parent.cwd.clone(), child_config(&parent.config, agent))?;
        chat.title = title.map(|t| t.trim().to_owned()).filter(|t| !t.is_empty());
        chat.worktree = parent.worktree.clone();
        chat.parent_chat_id = Some(parent.id.clone());
        self.store().save_chat(&chat)?;
        self.state().watchers.chats(ChatsUpdate::Upsert { chat: chat.clone() });
        self.send(&chat.id, prompt, Vec::new())?;
        Ok(chat)
    }

    /// The chats `parent_id`'s agent started, most recently active first.
    pub fn children(&self, parent_id: &str) -> Result<Vec<Chat>> {
        let mut chats = self.store().chats()?;
        chats.retain(|c| c.parent_chat_id.as_deref() == Some(parent_id));
        Ok(chats)
    }

    /// `child_id`, if it's one of `parent_id`'s children.
    pub fn child(&self, parent_id: &str, child_id: &str) -> Result<Chat> {
        self.store()
            .chat(child_id)?
            .filter(|c| c.parent_chat_id.as_deref() == Some(parent_id))
            .ok_or_else(|| EngineError::NotAChild(child_id.into()))
    }

    /// How `chat` stands now.
    pub fn child_status(&self, chat: &Chat) -> Result<ChildStatus> {
        let state = self.state();
        let session = state.sessions.get(&chat.id);
        let live = state.runs.get(&chat.id).and_then(|live| live.turn.as_ref()).map(|t| t.assistant.clone());
        let working = state.working(&chat.id) || state.summarizing.contains_key(&chat.id);
        let mut pending: BTreeSet<String> = session.map(|s| s.secrets.iter().map(|r| r.id.clone()).collect()).unwrap_or_default();
        if let Some(reply) = &live {
            pending.extend(reply.parts.iter().filter_map(|p| match p {
                MessagePart::Input { request_id, resolved: false, .. } => Some(request_id.clone()),
                _ => None,
            }));
        }
        let queued = session.map_or(0, |s| s.queued.len());
        drop(state);
        let latest = match live {
            Some(reply) => Some(reply),
            None => self.store().messages(&chat.id)?.into_iter().rev().find(|m| m.role == MessageRole::Assistant),
        };
        let (reply, error) = latest.as_ref().map(closing).unwrap_or_default();
        Ok(ChildStatus {
            chat: chat.clone(),
            state: if !pending.is_empty() {
                ChildState::WaitingOnUser
            } else if working || queued > 0 {
                ChildState::Working
            } else {
                ChildState::Idle
            },
            reply,
            error,
            stopped: latest.is_some_and(|m| m.status == Some(MessageStatus::Aborted)),
            queued,
            pending,
        })
    }

    /// Waits up to `timeout` for `chat` to go idle, or to wait on the user
    /// for something it wasn't already waiting on as this was called; then
    /// how it stands.
    pub async fn wait_child(&self, chat: &Chat, timeout: Duration) -> Result<ChildStatus> {
        // Watching first, so nothing between the check and the wait is missed.
        let (tx, mut changed) = mpsc::unbounded_channel();
        let id = chat.id.clone();
        let watch = self.watch_chats(move |update| {
            let ours = match &update {
                ChatsUpdate::Session { session } => session.chat_id == id,
                ChatsUpdate::Upsert { chat } => chat.id == id,
                ChatsUpdate::Removed { id: removed } => *removed == id,
                ChatsUpdate::Snapshot { .. } => false,
            };
            !ours || tx.send(()).is_ok()
        })?;
        let waited = async {
            let before = self.child_status(chat)?.pending;
            let deadline = tokio::time::Instant::now() + timeout;
            loop {
                let status = self.child_status(chat)?;
                let asks_anew = status.state == ChildState::WaitingOnUser && !status.pending.is_subset(&before);
                if status.state == ChildState::Idle || asks_anew {
                    return Ok(status);
                }
                // A reply's events don't all touch its session; look again now and then.
                let tick = tokio::time::sleep(Duration::from_secs(1));
                tokio::select! {
                    _ = changed.recv() => {}
                    _ = tick => {}
                    _ = tokio::time::sleep_until(deadline) => return Ok(status),
                }
                if self.store().chat(&chat.id)?.is_none() {
                    return Err(EngineError::NotFound(chat.id.clone()));
                }
            }
        }
        .await;
        self.unwatch(watch);
        waited
    }

    /// Stops the running turns of `parent_id`'s children.
    pub(crate) fn interrupt_children(&self, parent_id: &str) {
        let Ok(children) = self.children(parent_id) else {
            return;
        };
        for child in children {
            self.interrupt(&child.id);
        }
    }
}

/// A child's config: `agent`, with the parent's access and plan mode (so a
/// child can't do what its parent may not), and the parent's model and
/// effort where `agent` leaves them to it.
pub(crate) fn child_config(parent: &ChatConfig, agent: ChildAgent) -> ChatConfig {
    let same = agent.harness == parent.harness;
    let model = agent.model.map(|m| m.trim().to_owned()).filter(|m| !m.is_empty());
    let same_model = same && (model.is_none() || model == parent.model);
    ChatConfig {
        harness: agent.harness,
        model: if same && model.is_none() { parent.model.clone() } else { model },
        reasoning: agent.reasoning.or(if same_model { parent.reasoning } else { None }),
        model_options: if same_model { parent.model_options.clone() } else { Default::default() },
        access: parent.access,
        plan: parent.plan,
    }
}

/// A reply's closing text, after its last tool call or question (its last
/// text when nothing follows those), and its last error.
fn closing(reply: &Message) -> (Option<String>, Option<String>) {
    let text = |p: &MessagePart| match p {
        MessagePart::Text { text, .. } if !text.trim().is_empty() => Some(text.trim().to_owned()),
        _ => None,
    };
    let after = reply
        .parts
        .iter()
        .rposition(|p| matches!(p, MessagePart::Tool { .. } | MessagePart::Input { .. }))
        .map_or(0, |at| at + 1);
    let tail: Vec<String> = reply.parts[after..].iter().filter_map(text).collect();
    let body = if tail.is_empty() {
        reply.parts.iter().rev().find_map(text)
    } else {
        Some(tail.join("\n\n"))
    };
    let error = reply.parts.iter().rev().find_map(|p| match p {
        MessagePart::Error { message, .. } => Some(message.clone()),
        _ => None,
    });
    (body.map(|b| cap(b, MAX_REPLY_CHARS)), error)
}

/// The first `max` characters of `text`, saying when there were more.
fn cap(text: String, max: usize) -> String {
    match text.char_indices().nth(max) {
        Some((at, _)) => format!("{}\n\n[… cut; the rest is in the chat]", &text[..at]),
        None => text,
    }
}
