//! Chat titles: as a chat's first prompt is sent, a throwaway text run names
//! it from that prompt, alongside the turn (`Hooks::text_model`: no tools, no
//! project, the text generation model). If that's off or yields nothing, the prompt's
//! first words stand in. A rename by the user always wins.

use std::time::Duration;

use outcode_harness::Run;
use outcode_proto::{AgentEvent, ChatsUpdate, DoneStatus};

use crate::{Engine, TextUse};

/// The task a title run is given, before the prompt it names.
const TITLE_TASK: &str = "Write a title for this session. Return only a concise 3-5 word title \
    in Title Case, without quotes or punctuation.";

/// Waits before the second and third attempts.
const RETRY_DELAYS: [Duration; 2] = [Duration::from_millis(250), Duration::from_secs(1)];
const ATTEMPT_TIMEOUT: Duration = Duration::from_secs(30);
/// How long a finished title run gets to exit.
const EXIT_GRACE: Duration = Duration::from_secs(5);

impl Engine {
    /// Names the chat in the background from `prompt`, unless it has a
    /// title or one is on its way. Called with the state locked, as a turn
    /// starts.
    pub(crate) fn maybe_title(&self, titling: &mut std::collections::HashSet<String>, chat_id: &str, prompt: &str) {
        if !titling.insert(chat_id.to_owned()) {
            return;
        }
        let engine = self.clone();
        let chat_id = chat_id.to_owned();
        let prompt = prompt.to_owned();
        tokio::spawn(async move {
            let title = engine
                .generate_title(&prompt)
                .await
                .unwrap_or_else(|| fallback_title(&prompt));
            let mut state = engine.state();
            state.titling.remove(&chat_id);
            if title.is_empty() {
                return;
            }
            // A rename made meanwhile stays.
            match engine.store().update_chat(&chat_id, |chat| {
                if chat.title.is_none() {
                    chat.title = Some(title);
                }
            }) {
                Ok(chat) => state.watchers.chats(ChatsUpdate::Upsert { chat }),
                // Deleted meanwhile.
                Err(error) => eprintln!("[engine] titling {chat_id}: {error}"),
            }
        });
    }

    /// The text generation model's title, cleaned; `None` while titles are off or
    /// when every attempt failed.
    async fn generate_title(&self, prompt: &str) -> Option<String> {
        let body = format!(
            "{TITLE_TASK}\n\nSession request (JSON string):\n{}",
            serde_json::to_string(prompt).unwrap_or_default()
        );
        for attempt in 0..=RETRY_DELAYS.len() {
            match self.run_text(TextUse::Title, body.clone())? {
                Ok(run) => match collect_text(run, ATTEMPT_TIMEOUT).await {
                    Ok(text) => {
                        let title = clean_title(&text);
                        if !title.is_empty() {
                            return Some(title);
                        }
                        eprintln!("[engine] title attempt {}: empty", attempt + 1);
                    }
                    Err(error) => eprintln!("[engine] title attempt {}: {error}", attempt + 1),
                },
                // Not installed: retrying won't help.
                Err(error) => {
                    eprintln!("[engine] title run: {error}");
                    return None;
                }
            }
            if let Some(delay) = RETRY_DELAYS.get(attempt) {
                tokio::time::sleep(*delay).await;
            }
        }
        None
    }
}

/// The run's text up to its `Done`. A tool call fails it: a text run must
/// never act.
pub(crate) async fn collect_text(run: Run, timeout: Duration) -> Result<String, String> {
    let Run { mut events, handle } = run;
    let result = tokio::time::timeout(timeout, async {
        let mut text = String::new();
        while let Some(event) = events.recv().await {
            match event {
                AgentEvent::TextDelta { text: delta } => text.push_str(&delta),
                AgentEvent::ToolCall { .. } => return Err("it tried to use a tool".to_owned()),
                AgentEvent::Error { message } => return Err(message),
                AgentEvent::Done {
                    status: DoneStatus::Completed,
                } => return Ok(text),
                AgentEvent::Done { status } => return Err(format!("ended {status:?}")),
                _ => {}
            }
        }
        Err("the run ended before its turn did".to_owned())
    })
    .await
    .unwrap_or_else(|_| Err("timed out".to_owned()));
    handle.close();
    let _ = tokio::time::timeout(EXIT_GRACE, async { while events.recv().await.is_some() {} }).await;
    result
}

/// First line, without quotes, heading marks or a closing period, at most
/// 60 characters.
fn clean_title(raw: &str) -> String {
    let first = raw.trim().lines().next().unwrap_or("");
    first
        .trim_start_matches(['"', '\'', '#', '*', ' ', '\t'])
        .trim_end_matches(['"', '\'', '*', '.', ' ', '\t'])
        .chars()
        .take(60)
        .collect()
}

/// The prompt's first seven words, at most 48 characters.
pub(crate) fn fallback_title(prompt: &str) -> String {
    prompt
        .split_whitespace()
        .take(7)
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(48)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn titles_are_cleaned() {
        assert_eq!(clean_title("\"Fix Login Flow\"\nextra"), "Fix Login Flow");
        assert_eq!(clean_title("# Add Dark Mode.  "), "Add Dark Mode");
        assert_eq!(clean_title("**Bold Title**"), "Bold Title");
        assert_eq!(clean_title("   "), "");
    }

    #[test]
    fn the_fallback_is_the_prompts_first_words() {
        assert_eq!(
            fallback_title("please fix the  login flow on the settings page"),
            "please fix the login flow on the"
        );
        assert_eq!(fallback_title(&"x".repeat(100)).len(), 48);
    }
}
