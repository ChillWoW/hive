//! Chat titles, as zeron writes them: once a chat's first exchange
//! completes, a throwaway title run of a cheap model names it from the first
//! prompt. It runs in an empty temp folder with no tools, MCP servers or
//! settings ([`Harness::run_title`]). If that yields nothing, the prompt's
//! first words stand in. A rename by the user always wins.

use std::time::Duration;

use hive_harness::{Harness, Run, TITLE_INSTRUCTIONS};
use hive_proto::{
    AccessMode, AgentEvent, DoneStatus, HarnessId, MessagePart, MessageRole, Model, ReasoningLevel,
    RunRequest, SandboxLevel,
};
use std::sync::atomic::Ordering;
use std::sync::Arc;

use crate::{lock, Engine};

/// Waits before the second and third attempts.
const RETRY_DELAYS: [Duration; 2] = [Duration::from_millis(250), Duration::from_secs(1)];
const ATTEMPT_TIMEOUT: Duration = Duration::from_secs(30);
/// How long a finished title run gets to exit before its temp folder goes.
const EXIT_GRACE: Duration = Duration::from_secs(5);

impl Engine {
    /// Names `chat_id` in the background if it has no title yet. Called after
    /// every completed turn; does nothing while a title is already on its way.
    pub(crate) fn maybe_title(&self, chat_id: &str) {
        let titled = self
            .store()
            .chat(chat_id)
            .ok()
            .flatten()
            .is_none_or(|c| c.title.as_deref().is_some_and(|t| !t.trim().is_empty()));
        if titled || !lock(&self.inner.titling).insert(chat_id.to_owned()) {
            return;
        }
        let engine = self.clone();
        let chat_id = chat_id.to_owned();
        self.inner.runtime.spawn(async move {
            if let Err(e) = engine.title(&chat_id).await {
                log::warn!("titling chat {chat_id}: {e}");
            }
            lock(&engine.inner.titling).remove(&chat_id);
        });
    }

    async fn title(&self, chat_id: &str) -> crate::Result<()> {
        let chat = self.chat(chat_id)?;
        if chat.title.as_deref().is_some_and(|t| !t.trim().is_empty()) {
            return Ok(());
        }
        let Some(prompt) = self.first_prompt(chat_id)? else {
            return Ok(());
        };
        let generated = if self.inner.auto_title.load(Ordering::Relaxed) {
            self.generate_title(chat.config.harness, &prompt).await
        } else {
            None
        };
        let title = generated.unwrap_or_else(|| fallback_title(&prompt));
        if title.is_empty() {
            return Ok(());
        }
        // Under the chat's lock, like every other write to it; the store
        // checks the title again so a rename made meanwhile stays.
        let runtime = self.runtime_for(chat_id);
        let _st = lock(&runtime.state);
        if self.store().title_chat(chat_id, &title)?.is_some() {
            self.publish_chat(chat_id);
        }
        Ok(())
    }

    /// The chat's first user message, as text.
    fn first_prompt(&self, chat_id: &str) -> crate::Result<Option<String>> {
        let messages = self.store().messages(chat_id)?;
        let Some(user) = messages.iter().find(|m| m.role == MessageRole::User) else {
            return Ok(None);
        };
        let text: Vec<&str> = user
            .parts
            .iter()
            .filter_map(|p| match p {
                MessagePart::Text { text, .. } => Some(text.as_str()),
                _ => None,
            })
            .collect();
        let text = text.join("\n");
        if !text.trim().is_empty() {
            return Ok(Some(text));
        }
        // Only files were sent: their names say what it's about.
        let names: Vec<&str> = user.attachments.iter().map(|a| a.name.as_str()).collect();
        Ok((!names.is_empty()).then(|| names.join(", ")))
    }

    /// The title model's answer, cleaned; `None` if every attempt failed.
    async fn generate_title(&self, chat_harness: HarnessId, prompt: &str) -> Option<String> {
        let harness = self.title_harness(chat_harness)?;
        let catalog = harness.catalog();
        let model = cheapest_model(&catalog.models);
        // The lowest effort, where the model takes one.
        let reasoning = model
            .filter(|m| !m.reasoning_levels.is_empty())
            .map(|_| ReasoningLevel::Minimal);
        // No project instructions, files or session to pick up.
        let scratch = tempfile::tempdir().ok()?;
        let request = RunRequest {
            harness: harness.id(),
            prompt: format!(
                "{TITLE_INSTRUCTIONS}\n\nSession request (JSON string):\n{}",
                serde_json::to_string(prompt).ok()?
            ),
            cwd: scratch.path().to_string_lossy().into_owned(),
            sandbox: SandboxLevel::ReadOnly,
            model: model.map(|m| m.id.clone()),
            reasoning,
            model_options: Default::default(),
            auto_approve: false,
            access: AccessMode::Supervised,
            plan: false,
            resume: None,
            attachments: Vec::new(),
        };
        for attempt in 0..=RETRY_DELAYS.len() {
            match harness.run_title(request.clone()) {
                Ok(run) => match collect_text(run).await {
                    Ok(text) => {
                        let title = clean_title(&text);
                        if !title.is_empty() {
                            return Some(title);
                        }
                    }
                    Err(e) => log::warn!("title attempt {}: {e}", attempt + 1),
                },
                Err(e) => {
                    log::warn!("title attempt {}: {e}", attempt + 1);
                    return None; // Not installed: retrying won't help.
                }
            }
            if let Some(delay) = RETRY_DELAYS.get(attempt) {
                tokio::time::sleep(*delay).await;
            }
        }
        None
    }

    /// The chat's own harness if it writes titles, else the first installed
    /// one that does.
    fn title_harness(&self, chat_harness: HarnessId) -> Option<Arc<dyn Harness>> {
        let harnesses = &self.inner.harnesses;
        if let Some(h) = harnesses.get(&chat_harness).filter(|h| h.supports_titles()) {
            return Some(h.clone());
        }
        self.inner
            .order
            .iter()
            .filter_map(|id| harnesses.get(id))
            .find(|h| h.supports_titles() && h.catalog().installed)
            .cloned()
    }
}

/// The run's text up to its `Done`. A tool call or question fails it: a
/// title run must never act or wait on the user.
async fn collect_text(run: Run) -> Result<String, String> {
    let Run { mut events, handle } = run;
    let result = tokio::time::timeout(ATTEMPT_TIMEOUT, async {
        let mut text = String::new();
        while let Some(event) = events.recv().await {
            match event {
                AgentEvent::TextDelta { text: delta } => text.push_str(&delta),
                AgentEvent::ToolCall { .. } => return Err("it tried to use a tool".to_owned()),
                AgentEvent::InputRequested { .. } => return Err("it asked a question".to_owned()),
                AgentEvent::Error { message } => return Err(message),
                AgentEvent::Done {
                    status: DoneStatus::Completed,
                    ..
                } => return Ok(text),
                AgentEvent::Done { status, error, .. } => {
                    return Err(format!("{status:?}: {}", error.unwrap_or_default()))
                }
                _ => {}
            }
        }
        Err("the run ended before its turn did".to_owned())
    })
    .await
    .unwrap_or_else(|_| Err("timed out".to_owned()));
    // Let the process exit before its folder is removed.
    handle.close();
    let _ =
        tokio::time::timeout(EXIT_GRACE, async { while events.recv().await.is_some() {} }).await;
    result
}

/// A small-tier model (haiku, mini, nano, flash, small, lite), else the
/// last listed; `None` for an empty catalog (the harness's default).
fn cheapest_model(models: &[Model]) -> Option<&Model> {
    models
        .iter()
        .find(|m| {
            let name = format!("{} {}", m.id, m.label).to_lowercase();
            ["haiku", "mini", "nano", "flash", "small", "lite"]
                .iter()
                .any(|tier| name.contains(tier))
        })
        .or(models.last())
}

/// First line, without quotes or heading marks, at most 60 characters.
fn clean_title(raw: &str) -> String {
    let first = raw.trim().lines().next().unwrap_or("");
    first
        .trim_start_matches(['"', '\'', '#', ' ', '\t'])
        .trim_end_matches(['"', '\'', ' ', '\t'])
        .chars()
        .take(60)
        .collect()
}

/// The prompt's first seven words, at most 48 characters.
fn fallback_title(prompt: &str) -> String {
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

    fn model(id: &str, label: &str) -> Model {
        Model {
            id: id.into(),
            label: label.into(),
            description: None,
            reasoning_levels: vec![],
            options: vec![],
        }
    }

    #[test]
    fn cheapest_prefers_a_small_tier_then_the_last() {
        let id = |models: &[Model]| cheapest_model(models).map(|m| m.id.clone());
        let models = [
            model("opus", "Opus"),
            model("haiku", "Haiku"),
            model("sonnet", "Sonnet"),
        ];
        assert_eq!(id(&models).as_deref(), Some("haiku"));
        let models = [model("opus", "Opus"), model("sonnet", "Sonnet")];
        assert_eq!(id(&models).as_deref(), Some("sonnet"));
        assert_eq!(id(&[]), None);
    }

    #[test]
    fn titles_are_cleaned() {
        assert_eq!(clean_title("\"Fix Login Flow\"\nextra"), "Fix Login Flow");
        assert_eq!(clean_title("# Add Dark Mode  "), "Add Dark Mode");
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
