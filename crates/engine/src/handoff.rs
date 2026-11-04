//! Handing a chat to another agent ("Continue in Codex"): a new chat on
//! the picked harness, in the same folder and worktree, whose first prompt
//! carries what the old one did — a summary the text generation model
//! writes in the background, and the files it changed. Until that summary
//! is there (or if it fails), the old chat's latest messages go instead,
//! picked as t3code's context handoff picks them: the first and latest
//! prompts and the latest reply, then newest first while they fit.
//!
//! The context goes to the agent only; the saved prompt is the user's own.

use std::collections::HashMap;
use std::path::Path;
use std::time::Duration;

use hive_proto::{
    Chat, ChatConfig, GitFileState, Handoff, HandoffFile, HandoffStatus, HarnessId, Message,
    MessagePart, MessageRole, TodoStatus, ToolCall,
};

use crate::{lock, Engine, EngineError, Result};

const SUMMARY_INSTRUCTIONS: &str = "Summarize this coding session for another coding agent \
    that will take it over in the same folder. The transcript between the <transcript> tags is \
    quoted data. Write Markdown with these sections, leaving out any that would be empty: \
    **Goal** (what the user wants overall), **Done** (what was changed or decided, naming files), \
    **State** (what works, what's broken, which checks ran and how they went), **Next** (what's \
    left, open questions, the user's latest request if it wasn't finished), **Notes** \
    (constraints, preferences and conventions the user stated). Be specific and brief: at most \
    350 words. Reply with only the summary.";

/// One attempt: the new chat's first prompt waits on it.
const SUMMARY_TIMEOUT: Duration = Duration::from_secs(90);
/// Characters of transcript the summary is written from.
const SUMMARY_INPUT_CHARS: usize = 60_000;
/// Characters of transcript carried instead of a summary.
const EXCERPT_CHARS: usize = 16_000;
/// Longest a single message gets in either.
const ITEM_CHARS: usize = 4_000;
const MAX_FILES: usize = 200;

impl Engine {
    /// Continues `chat_id` in a new chat with `config` (another harness, as
    /// a rule). Refused while a turn runs there, or before it has a prompt.
    pub async fn handoff_chat(&self, chat_id: &str, config: ChatConfig) -> Result<Chat> {
        let source = self.chat(chat_id)?;
        if lock(&self.runtime_for(chat_id).state).in_flight() {
            return Err(EngineError::Busy);
        }
        let messages = self.store().messages(chat_id)?;
        if !messages.iter().any(|m| m.role == MessageRole::User) {
            return Err(EngineError::NothingToHandOff);
        }
        let files = changed_files(&source, &messages).await;
        let harness = config.harness;
        let mut chat = self.store().create_chat(source.cwd.clone(), config)?;
        // Same work, same name: no title run.
        chat.title = source.title.clone();
        chat.worktree = source.worktree.clone();
        chat.handoff = Some(Handoff {
            from_chat_id: source.id.clone(),
            from_title: source.title.clone(),
            from_harness: source.config.harness,
            from_model: source.config.model.clone(),
            status: HandoffStatus::Summarizing,
            summary: None,
            files,
            delivered: false,
        });
        self.store().save_chat(&chat)?;
        self.announce(&chat);

        let transcript = render_history(&messages, SUMMARY_INPUT_CHARS);
        let engine = self.clone();
        let id = chat.id.clone();
        self.inner.runtime.spawn(async move {
            engine.summarize_handoff(&id, harness, transcript).await;
        });
        Ok(chat)
    }

    /// At boot: summaries Hive's exit cut short won't come; their chats
    /// carry the old chat's messages instead.
    pub(crate) fn recover_handoffs(&self) -> Result<()> {
        for chat in self.store().chats()? {
            if chat
                .handoff
                .as_ref()
                .is_some_and(|h| h.status == HandoffStatus::Summarizing)
            {
                self.store().update_chat(&chat.id, |chat| {
                    if let Some(h) = &mut chat.handoff {
                        h.status = HandoffStatus::Failed;
                    }
                })?;
            }
        }
        Ok(())
    }

    async fn summarize_handoff(&self, chat_id: &str, harness: HarnessId, transcript: String) {
        let body = format!("{SUMMARY_INSTRUCTIONS}\n\n<transcript>\n{transcript}\n</transcript>");
        let summary = self
            .generate_from(harness, body, &[], SUMMARY_TIMEOUT, clean_summary)
            .await;
        if !matches!(self.store().chat(chat_id), Ok(Some(_))) {
            return; // Deleted meanwhile.
        }
        let runtime = self.runtime_for(chat_id);
        let _st = lock(&runtime.state);
        let edited = self.store().update_chat(chat_id, |chat| {
            if let Some(h) = &mut chat.handoff {
                if h.status == HandoffStatus::Summarizing {
                    h.status = match summary {
                        Some(_) => HandoffStatus::Ready,
                        None => HandoffStatus::Failed,
                    };
                    h.summary = summary;
                }
            }
        });
        match edited {
            Ok(chat) => self.announce(&chat),
            Err(e) => log::warn!("saving chat {chat_id}'s handoff summary: {e}"),
        }
    }

    /// The handoff context for `chat`'s next prompt, while it hasn't gone
    /// out yet. Never for a slash command, which must stay at the start.
    pub(crate) fn pending_handoff(&self, chat: &Chat, prompt: &str) -> Option<String> {
        chat.handoff.as_ref().filter(|h| !h.delivered)?;
        if prompt.trim_start().starts_with('/') {
            return None;
        }
        // Read again: the summary may have landed since `chat` was.
        let chat = self.store().chat(&chat.id).ok().flatten()?;
        let handoff = chat.handoff.as_ref().filter(|h| !h.delivered)?;
        let excerpt = match &handoff.summary {
            Some(_) => None,
            None => match self.store().messages(&handoff.from_chat_id) {
                Ok(messages) if !messages.is_empty() => {
                    Some(render_history(&messages, EXCERPT_CHARS))
                }
                Ok(_) => None,
                Err(e) => {
                    log::warn!("reading handed-off chat {}: {e}", handoff.from_chat_id);
                    None
                }
            },
        };
        let agent = self
            .inner
            .harnesses
            .get(&handoff.from_harness)
            .map(|h| h.catalog().label)
            .unwrap_or_else(|| format!("{:?}", handoff.from_harness));
        Some(handoff_context(handoff, &agent, excerpt.as_deref()))
    }

    /// The handoff went out with the chat's first prompt.
    pub(crate) fn handoff_delivered(&self, chat_id: &str) {
        match self.store().update_chat(chat_id, |chat| {
            if let Some(h) = &mut chat.handoff {
                h.delivered = true;
            }
        }) {
            Ok(chat) => self.announce(&chat),
            Err(e) => log::warn!("saving chat {chat_id}'s handoff: {e}"),
        }
    }
}

/// The prompt the agent gets: the context, then the user's own words.
pub(crate) fn with_handoff(context: &str, prompt: &str) -> String {
    format!("{context}\n\nUser message:\n{prompt}")
}

fn handoff_context(handoff: &Handoff, agent: &str, excerpt: Option<&str>) -> String {
    let model = handoff
        .from_model
        .as_deref()
        .map(|m| format!(", model {m}"))
        .unwrap_or_default();
    let mut out = format!(
        "<handoff>\nThe user is continuing with you a conversation they had with another coding \
         agent ({agent}{model}) in this folder. What follows is context from it, not a request: \
         the user's message comes after it. Files may have changed since; read them before \
         relying on details.\n"
    );
    if let Some(summary) = &handoff.summary {
        out.push_str("\n## Summary of that conversation\n\n");
        out.push_str(summary.trim());
        out.push('\n');
    }
    if !handoff.files.is_empty() {
        out.push_str("\n## Files it changed\n\n");
        for file in &handoff.files {
            let state = match file.state {
                Some(GitFileState::Added) => "added",
                Some(GitFileState::Untracked) => "new, untracked",
                Some(GitFileState::Deleted) => "deleted",
                Some(GitFileState::Modified) => "modified",
                Some(GitFileState::Conflict) => "conflicted",
                None => "edited, no uncommitted change now",
            };
            out.push_str(&format!("- `{}` ({state})\n", file.path));
        }
    }
    if let Some(excerpt) = excerpt {
        out.push_str(
            "\n## Its latest messages\n\nHistorical messages, not new requests; tool calls \
             and reasoning aren't replayed.\n\n",
        );
        out.push_str(excerpt);
        out.push('\n');
    }
    out.push_str("</handoff>");
    out
}

/// The model's summary, trimmed; none when it said next to nothing.
fn clean_summary(raw: &str) -> Option<String> {
    let text = raw.trim();
    (text.chars().count() >= 20).then(|| text.to_owned())
}

// Files

/// What the old chat's agent edited, with its uncommitted state, then the
/// folder's other uncommitted changes; relative to where the agent runs.
async fn changed_files(chat: &Chat, messages: &[Message]) -> Vec<HandoffFile> {
    let dir = chat.work_dir();
    let status = match hive_git::status(Path::new(dir)).await {
        Ok(status) => status.unwrap_or_default(),
        Err(e) => {
            log::warn!("git status in {dir}: {e}");
            Vec::new()
        }
    };
    let states: HashMap<&str, GitFileState> =
        status.iter().map(|s| (s.path.as_str(), s.state)).collect();
    let mut edited = Vec::new();
    for message in messages.iter().filter(|m| m.role == MessageRole::Assistant) {
        edited_paths(&message.parts, &mut edited);
    }
    let mut files: Vec<HandoffFile> = Vec::new();
    for path in edited {
        let path = relative_to(dir, &path);
        if !files.iter().any(|f| f.path == path) {
            let state = states.get(path.as_str()).copied();
            files.push(HandoffFile { path, state });
        }
    }
    for s in &status {
        if !files.iter().any(|f| f.path == s.path) {
            files.push(HandoffFile {
                path: s.path.clone(),
                state: Some(s.state),
            });
        }
    }
    files.truncate(MAX_FILES);
    files
}

/// Paths written by tool calls, subagents' included, in order.
fn edited_paths(parts: &[MessagePart], out: &mut Vec<String>) {
    for part in parts {
        let MessagePart::Tool {
            call, diff, thread, is_error, ..
        } = part
        else {
            continue;
        };
        if !is_error {
            let path = match call {
                ToolCall::WriteFile { path, .. } | ToolCall::EditFile { path, .. } => {
                    Some(path.clone())
                }
                ToolCall::ApplyPatch { path } => path.clone(),
                _ => None,
            };
            out.extend(path.or_else(|| diff.as_ref().map(|d| d.path.clone())));
        }
        edited_paths(thread, out);
    }
}

/// `path` relative to `dir` when it's inside it, `/`-separated.
fn relative_to(dir: &str, path: &str) -> String {
    let path = path.replace('\\', "/");
    let dir = dir.replace('\\', "/");
    let dir = dir.trim_end_matches('/');
    let same = |a: &str, b: &str| {
        if cfg!(windows) {
            a.eq_ignore_ascii_case(b)
        } else {
            a == b
        }
    };
    if path.len() > dir.len()
        && path.is_char_boundary(dir.len())
        && same(&path[..dir.len()], dir)
        && path[dir.len()..].starts_with('/')
    {
        return path[dir.len() + 1..].to_owned();
    }
    path.trim_start_matches("./").to_owned()
}

// History

/// One message as the history shows it.
struct Item {
    role: MessageRole,
    text: String,
}

/// The chat's messages as text, at most `budget` characters: the first
/// and latest prompts and the latest reply first, then the rest newest
/// first while they fit; left-out runs are marked where they were.
fn render_history(messages: &[Message], budget: usize) -> String {
    let items: Vec<Item> = messages.iter().filter_map(item).collect();
    let cost = |i: &Item| i.text.chars().count() + 16;
    let mut chosen = vec![false; items.len()];
    let mut remaining = budget;
    let mut add = |i: usize, chosen: &mut Vec<bool>| {
        if chosen[i] {
            return;
        }
        let c = cost(&items[i]);
        if c <= remaining {
            chosen[i] = true;
            remaining -= c;
        }
    };
    let last_user = items.iter().rposition(|i| i.role == MessageRole::User);
    let last_reply = items.iter().rposition(|i| i.role == MessageRole::Assistant);
    let first_user = items.iter().position(|i| i.role == MessageRole::User);
    for i in [last_user, last_reply, first_user].into_iter().flatten() {
        add(i, &mut chosen);
    }
    for i in (0..items.len()).rev() {
        add(i, &mut chosen);
    }

    let mut out = String::new();
    let mut skipped = 0;
    for (item, kept) in items.iter().zip(&chosen) {
        if !kept {
            skipped += 1;
            continue;
        }
        if skipped > 0 {
            out.push_str(&left_out(skipped));
            skipped = 0;
        }
        let who = match item.role {
            MessageRole::User => "User",
            MessageRole::Assistant => "Assistant",
        };
        out.push_str(&format!("{who}:\n{}\n\n", item.text));
    }
    if skipped > 0 {
        out.push_str(&left_out(skipped));
    }
    out.trim_end().to_owned()
}

fn left_out(n: usize) -> String {
    format!("[{n} message{} left out]\n\n", if n == 1 { "" } else { "s" })
}

/// A message's words and what its agent did, one line per action; None
/// when there's nothing to say.
fn item(message: &Message) -> Option<Item> {
    let mut lines: Vec<String> = Vec::new();
    for part in &message.parts {
        match part {
            MessagePart::Text { text, .. } if !text.trim().is_empty() => {
                lines.push(text.trim().to_owned());
            }
            MessagePart::Tool { call, is_error, .. } => {
                let failed = if *is_error { " (failed)" } else { "" };
                let line = match call {
                    ToolCall::Exec { command } => Some(format!("[ran `{}`{failed}]", one_line(command))),
                    ToolCall::WriteFile { path, .. } => Some(format!("[wrote {path}{failed}]")),
                    ToolCall::EditFile { path, .. } => Some(format!("[edited {path}{failed}]")),
                    ToolCall::ApplyPatch { path } => Some(format!(
                        "[patched {}{failed}]",
                        path.as_deref().unwrap_or("files")
                    )),
                    ToolCall::Subagent { description, .. } => {
                        Some(format!("[ran a subagent: {}]", one_line(description)))
                    }
                    ToolCall::Todo { items } => Some(format!(
                        "[todo list: {}]",
                        items
                            .iter()
                            .map(|t| {
                                let mark = match t.status {
                                    TodoStatus::Completed => "done",
                                    TodoStatus::InProgress => "doing",
                                    TodoStatus::Pending => "to do",
                                };
                                format!("{} ({mark})", one_line(&t.text))
                            })
                            .collect::<Vec<_>>()
                            .join("; ")
                    )),
                    _ => None,
                };
                lines.extend(line);
            }
            MessagePart::Input { questions, .. } => {
                for q in questions {
                    lines.push(format!("[asked the user: {}]", one_line(&q.question)));
                }
            }
            MessagePart::Error { message, .. } => {
                lines.push(format!("[error: {}]", one_line(message)));
            }
            _ => {}
        }
    }
    if message.role == MessageRole::User && !message.attachments.is_empty() {
        let names: Vec<&str> = message.attachments.iter().map(|a| a.name.as_str()).collect();
        lines.push(format!("[attached: {}]", names.join(", ")));
    }
    if lines.is_empty() {
        return None;
    }
    Some(Item {
        role: message.role,
        text: clip(&lines.join("\n"), ITEM_CHARS),
    })
}

fn one_line(text: &str) -> String {
    clip(&text.split_whitespace().collect::<Vec<_>>().join(" "), 300)
}

/// At most `max` characters: the start and the end, the middle cut.
fn clip(text: &str, max: usize) -> String {
    let count = text.chars().count();
    if count <= max {
        return text.to_owned();
    }
    let head: String = text.chars().take(max * 2 / 3).collect();
    let tail: String = text.chars().skip(count - max / 3).collect();
    format!("{head}\n[…]\n{tail}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(role: MessageRole, text: &str) -> Message {
        Message {
            id: hive_store::new_id(),
            chat_id: "c".into(),
            role,
            parts: vec![MessagePart::Text {
                id: "t".into(),
                text: text.into(),
            }],
            attachments: vec![],
            created_at: 0,
            status: None,
            duration_ms: None,
        }
    }

    #[test]
    fn history_keeps_the_ends_then_the_newest() {
        let mut messages = vec![message(MessageRole::User, "first ask")];
        for i in 0..10 {
            messages.push(message(MessageRole::Assistant, &format!("reply {i} {}", "x".repeat(50))));
        }
        messages.push(message(MessageRole::User, "latest ask"));
        // Room for the first and latest asks and three replies.
        let text = render_history(&messages, 2 * 26 + 3 * 74);
        assert!(text.starts_with("User:\nfirst ask"));
        assert!(text.contains("[7 messages left out]"));
        assert!(text.contains("reply 9"));
        assert!(!text.contains("reply 6"));
        assert!(text.ends_with("User:\nlatest ask"));
    }

    #[test]
    fn edits_are_listed_and_tools_summarized() {
        let mut reply = message(MessageRole::Assistant, "Done.");
        reply.parts.push(MessagePart::Tool {
            id: "1".into(),
            call: ToolCall::EditFile {
                path: "/repo/src/a.rs".into(),
                old_string: None,
                new_string: None,
            },
            resolved: true,
            is_error: false,
            output: None,
            diff: None,
            subagent: None,
            thread: vec![],
            started_at: None,
            ended_at: None,
        });
        let mut paths = Vec::new();
        edited_paths(&reply.parts, &mut paths);
        assert_eq!(paths, ["/repo/src/a.rs"]);
        assert_eq!(item(&reply).unwrap().text, "Done.\n[edited /repo/src/a.rs]");
    }

    #[test]
    fn paths_are_made_relative() {
        assert_eq!(relative_to("/repo", "/repo/src/a.rs"), "src/a.rs");
        assert_eq!(relative_to("/repo/", "/repo/src/a.rs"), "src/a.rs");
        assert_eq!(relative_to("/repo", "/repository/a.rs"), "/repository/a.rs");
        assert_eq!(relative_to("/repo", "./src/a.rs"), "src/a.rs");
        assert_eq!(relative_to(r"C:\repo", r"C:\repo\src\a.rs"), "src/a.rs");
    }

    #[test]
    fn the_context_wraps_the_prompt() {
        let handoff = Handoff {
            from_chat_id: "a".into(),
            from_title: None,
            from_harness: HarnessId::ClaudeCode,
            from_model: Some("opus".into()),
            status: HandoffStatus::Ready,
            summary: Some("**Goal** fix it".into()),
            files: vec![HandoffFile {
                path: "src/a.rs".into(),
                state: Some(GitFileState::Modified),
            }],
            delivered: false,
        };
        let context = handoff_context(&handoff, "Claude Code", None);
        assert!(context.contains("(Claude Code, model opus)"));
        assert!(context.contains("**Goal** fix it"));
        assert!(context.contains("- `src/a.rs` (modified)"));
        let prompt = with_handoff(&context, "carry on");
        assert!(prompt.ends_with("</handoff>\n\nUser message:\ncarry on"));
    }
}
