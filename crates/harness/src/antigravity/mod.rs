//! Antigravity: spawns Google's `agy` CLI as `agy acp` and speaks the Agent
//! Client Protocol over stdin/stdout ([`acp`]).
//!
//! - A run is one ACP session: `session/new`, or `session/resume` with the
//!   chat's session id (one that can't be resumed is replaced by a new
//!   session, with a note), then `session/prompt` per prompt. A prompt sent
//!   mid-turn waits for the turn to end.
//! - The model is a family (`gemini-3.8-flash`) set with
//!   `session/set_config_option`, its effort the `thought_level` option.
//! - `session/update`s become events in [`normalize`]: message and thought
//!   chunks, tool calls by their ACP kind and agy's own input fields, `plan`
//!   as a todo list, `usage_update` as context occupancy, the session's
//!   commands and skills.
//! - Access: agy has no mode that runs everything unasked, so supervised
//!   runs in its `default` mode and the others in `accept-edits`; its
//!   permission requests are answered here by the mode (full access allows
//!   everything, auto-accept edits allows edits) or asked as
//!   [`InputRequest::Approval`]s. Plan mode is agy's `plan` mode. Its own
//!   questions arrive as permission requests too (`interaction_…` calls),
//!   asked as [`InputRequest::Questions`].
//! - Attachments: paths listed under the prompt, images also as image
//!   blocks. Slash commands and skills go to agy as typed.
//! - Interrupt is `session/cancel`; a turn that doesn't report its end
//!   within a few seconds is reported interrupted anyway.
//! - Models come from `agy models`, cached and refreshed in the background.
//!
//! [`InputRequest::Approval`]: outcode_proto::InputRequest::Approval
//! [`InputRequest::Questions`]: outcode_proto::InputRequest::Questions

mod acp;
mod models;
mod normalize;
pub mod provider;
mod session;

use std::path::{Path, PathBuf};

use outcode_proto::{Catalog, ChatConfig, CommandKind, HarnessId, RunRequest, SlashCommand};

use crate::{BoxFuture, Harness, HarnessError, Run, cli};
use session::CommandCache;

const NAME: &str = "agy";

/// agy's built-in commands, offered before a session lists its own.
const BUILTINS: &[(&str, &str)] = &[
    ("compact", "Compact the conversation now (summarize history to free up the context window)."),
    ("goal", "Run until the specified goal is completely finished."),
    ("plan", "Plan carefully before executing a task."),
    ("schedule", "Run an instruction on a recurring schedule or as a one-time timer."),
    ("browser", "Invoke a browser agent for web tasks."),
];

/// Antigravity as a [`Harness`]. Its [`Options`] are read as each call
/// starts.
pub struct Antigravity {
    options: Box<dyn Fn() -> Options + Send + Sync>,
    models: models::Cache,
    commands: CommandCache,
}

/// What each Antigravity run starts with, beyond its request.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Options {
    /// The `agy` binary; else [`find`] finds it.
    pub binary: Option<PathBuf>,
}

impl Antigravity {
    pub fn new(options: impl Fn() -> Options + Send + Sync + 'static) -> Self {
        Self {
            options: Box::new(options),
            models: models::Cache::default(),
            commands: CommandCache::default(),
        }
    }

    fn exe(&self) -> Result<PathBuf, HarnessError> {
        find((self.options)().binary.as_deref())
    }

    fn start(&self, request: RunRequest, text: bool) -> Result<Run, HarnessError> {
        let exe = self.exe()?;
        Ok(session::start(session::Launch {
            exe,
            request,
            text,
            commands: self.commands.clone(),
        }))
    }
}

impl Harness for Antigravity {
    fn id(&self) -> HarnessId {
        HarnessId::Antigravity
    }

    fn catalog(&self) -> Catalog {
        let exe = self.exe().ok();
        if let Some(exe) = &exe {
            self.models.refresh(exe);
        }
        let models = self.models.models().unwrap_or_default();
        Catalog {
            installed: exe.is_some(),
            default_model: models.default,
            models: models.models,
        }
    }

    fn run(&self, request: RunRequest) -> Result<Run, HarnessError> {
        self.start(request, false)
    }

    /// A session in an empty scratch folder with [`crate::TEXT_INSTRUCTIONS`]
    /// added to its system prompt; every tool call it asks for is refused.
    fn run_text(&self, prompt: String, model: Option<&str>) -> Result<Run, HarnessError> {
        let scratch = std::env::temp_dir().join("outcode-text");
        std::fs::create_dir_all(&scratch).map_err(|e| HarnessError::Spawn(NAME, e))?;
        let request = RunRequest {
            cwd: scratch.to_string_lossy().into_owned(),
            prompt,
            config: ChatConfig {
                harness: HarnessId::Antigravity,
                model: model.filter(|m| !m.is_empty()).map(Into::into),
                ..ChatConfig::default()
            },
            ..RunRequest::default()
        };
        self.start(request, true)
    }

    /// What the last session in `cwd` listed, else agy's built-ins: listing
    /// them takes a session, which agy keeps on disk.
    fn commands<'a>(&'a self, cwd: &'a str) -> BoxFuture<'a, Result<Vec<SlashCommand>, HarnessError>> {
        Box::pin(async move {
            if let Some(listed) = self.commands.lock().unwrap().get(cwd) {
                return Ok(listed.clone());
            }
            Ok(BUILTINS
                .iter()
                .map(|(name, description)| SlashCommand {
                    name: (*name).into(),
                    description: (*description).into(),
                    input_hint: None,
                    kind: CommandKind::Command,
                })
                .collect())
        })
    }
}

/// The `agy` binary: `binary` when given, else on PATH or where its
/// installer puts it.
pub fn find(binary: Option<&Path>) -> Result<PathBuf, HarnessError> {
    if let Some(binary) = binary {
        return if binary.is_file() {
            Ok(binary.to_owned())
        } else {
            Err(HarnessError::BinaryMissing(binary.display().to_string()))
        };
    }
    let mut paths = Vec::new();
    if cfg!(windows) {
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            paths.push(PathBuf::from(local).join(r"agy\bin\agy.exe"));
        }
    } else if let Some(home) = cli::home_dir() {
        paths.push(home.join(".local/bin/agy"));
        paths.push(home.join(".agy/bin/agy"));
        paths.push("/opt/homebrew/bin/agy".into());
        paths.push("/usr/local/bin/agy".into());
    }
    cli::find(NAME, paths).ok_or(HarnessError::NotInstalled(NAME))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_binary_is_reported_and_not_installed() {
        let agy = Antigravity::new(|| Options {
            binary: Some("/nowhere/agy".into()),
        });
        assert!(matches!(agy.exe(), Err(HarnessError::BinaryMissing(_))));
        assert!(!agy.catalog().installed);
        assert!(matches!(agy.run(RunRequest::default()), Err(HarnessError::BinaryMissing(_))));
    }
}
