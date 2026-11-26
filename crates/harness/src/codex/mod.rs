//! Codex: spawns the installed `codex` CLI as `codex app-server` and speaks
//! its JSON-RPC protocol over stdin/stdout ([`rpc`]).
//!
//! - A run is one app-server holding one thread: `thread/start`, or
//!   `thread/resume` with the chat's thread id (one that can't be resumed is
//!   replaced by a new thread, with a note), then `turn/start` per prompt. A
//!   prompt sent mid-turn waits for the turn to end.
//! - Notifications become events in [`normalize`]: agent messages as text,
//!   reasoning, commands / file changes / MCP calls / web searches as tool
//!   calls, `turn/plan/updated` as a todo list, token usage as context
//!   occupancy, a spawned subagent's thread as [`AgentEvent::Subagent`].
//! - Access: full access runs unsandboxed with `approvalPolicy: never`; the
//!   others with `untrusted` in the user's own sandbox, and the server's
//!   approval requests are answered here by the mode (auto-accept edits
//!   accepts file changes) or asked as [`InputRequest::Approval`]s.
//!   `item/tool/requestUserInput` (the model's own questions) is asked as is.
//!   Each turn names the policy, so a mode change applies from the next.
//! - Plan mode is Codex's `plan` collaboration mode, named on every turn. A
//!   plan-mode turn that ends with a plan asks whether to implement it
//!   ([`InputRequest::Plan`]), then runs "Implement the plan." in default
//!   mode within the same reply, as Claude's `ExitPlanMode` does.
//! - Attachments: paths listed under the prompt, images also as
//!   `localImage` inputs. `$skill` mentions add `skill` inputs. `/compact`
//!   and `/review [instructions]` become `thread/compact/start` and
//!   `review/start`.
//! - Interrupt is `turn/interrupt`; a turn that doesn't report its end within
//!   a few seconds is reported interrupted anyway.
//! - Models come from `model/list`, cached and refreshed in the background;
//!   until the first answer, from the CLI's own `models_cache.json`.
//! - ⚠ App-servers starting together race on `$CODEX_HOME`'s SQLite and one
//!   dies: they start one at a time, with retries ([`rpc::Server::start`]).
//!
//! [`AgentEvent::Subagent`]: outcode_proto::AgentEvent::Subagent
//! [`InputRequest::Approval`]: outcode_proto::InputRequest::Approval
//! [`InputRequest::Plan`]: outcode_proto::InputRequest::Plan

mod models;
mod normalize;
pub mod provider;
mod rpc;
mod session;
mod skills;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use outcode_proto::{Catalog, ChatConfig, HarnessId, RunRequest, SlashCommand};
use serde_json::json;

use crate::{BoxFuture, Harness, HarnessError, Run, cli};
use rpc::Server;
use skills::Skill;

const NAME: &str = "codex";
/// How long a skills probe's answer is reused for the same folder.
const PROBE_TTL: Duration = Duration::from_secs(30);
const PROBE_TIMEOUT: Duration = Duration::from_secs(30);

/// Codex as a [`Harness`]. Its [`Options`] are read as each call starts.
pub struct Codex {
    options: Box<dyn Fn() -> Options + Send + Sync>,
    models: models::Cache,
    /// Each folder's skills, as the last run or probe there listed them.
    skills: Arc<Mutex<HashMap<String, Vec<Skill>>>>,
    /// When each folder's skills were last probed.
    probes: Arc<Mutex<HashMap<String, Instant>>>,
}

/// What each Codex run starts with, beyond its request.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Options {
    /// The `codex` binary; else [`find`] finds it.
    pub binary: Option<PathBuf>,
}

impl Codex {
    pub fn new(options: impl Fn() -> Options + Send + Sync + 'static) -> Self {
        Self {
            options: Box::new(options),
            models: models::Cache::default(),
            skills: Arc::default(),
            probes: Arc::default(),
        }
    }

    fn exe(&self) -> Result<PathBuf, HarnessError> {
        find((self.options)().binary.as_deref())
    }

    /// A level the model doesn't offer becomes the closest one it does (the
    /// next higher, else the highest): Codex refuses the rest.
    fn fit_reasoning(&self, config: &mut ChatConfig) {
        let Some(level) = config.reasoning else {
            return;
        };
        let Some(models) = self.models.models() else {
            return;
        };
        let id = config.model.clone().filter(|m| !m.is_empty()).or(models.default.clone());
        if let Some(model) = id.as_deref().and_then(|id| models.get(id)) {
            config.reasoning = models::closest_level(&model.reasoning_levels, level);
        }
    }

    fn start(&self, mut request: RunRequest, text: bool) -> Result<Run, HarnessError> {
        let exe = self.exe()?;
        self.fit_reasoning(&mut request.config);
        Ok(session::start(session::Launch {
            exe,
            request,
            text,
            skills: Arc::clone(&self.skills),
        }))
    }
}

impl Harness for Codex {
    fn id(&self) -> HarnessId {
        HarnessId::Codex
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

    /// An ephemeral, read-only thread with [`crate::TEXT_INSTRUCTIONS`] as
    /// its base instructions, in an empty scratch folder; anything it asks
    /// is refused.
    fn run_text(&self, prompt: String, model: Option<&str>) -> Result<Run, HarnessError> {
        let scratch = std::env::temp_dir().join("outcode-text");
        std::fs::create_dir_all(&scratch).map_err(|e| HarnessError::Spawn(NAME, e))?;
        let request = RunRequest {
            cwd: scratch.to_string_lossy().into_owned(),
            prompt,
            config: ChatConfig {
                model: model.filter(|m| !m.is_empty()).map(Into::into),
                ..ChatConfig::default()
            },
            ..RunRequest::default()
        };
        self.start(request, true)
    }

    /// The built-in commands and the skills of `cwd`: `skills/list` on an
    /// app-server started for it, reused a little while per folder.
    fn commands<'a>(&'a self, cwd: &'a str) -> BoxFuture<'a, Result<Vec<SlashCommand>, HarnessError>> {
        Box::pin(async move {
            let fresh = self
                .probes
                .lock()
                .unwrap()
                .get(cwd)
                .is_some_and(|at| at.elapsed() < PROBE_TTL);
            let known = self.skills.lock().unwrap().get(cwd).cloned();
            if let (true, Some(known)) = (fresh, &known) {
                return Ok(skills::commands(known));
            }
            let exe = self.exe()?;
            let dir = (!cwd.trim().is_empty()).then(|| PathBuf::from(cwd)).or_else(cli::home_dir);
            let params = json!({ "cwds": [cwd] });
            let result = Server::one_shot(&exe, dir.as_deref(), "skills/list", params, PROBE_TIMEOUT)
                .await
                .map_err(HarnessError::Probe)?;
            let listed = skills::parse(&result);
            self.skills.lock().unwrap().insert(cwd.to_owned(), listed.clone());
            self.probes.lock().unwrap().insert(cwd.to_owned(), Instant::now());
            Ok(skills::commands(&listed))
        })
    }
}

/// The `codex` binary: `binary` when given, else on PATH or where its
/// installers put it.
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
            paths.push(PathBuf::from(local).join(r"Programs\OpenAI\Codex\bin\codex.exe"));
        }
        if let Some(appdata) = std::env::var_os("APPDATA") {
            paths.push(PathBuf::from(appdata).join(r"npm\codex.cmd"));
        }
    } else {
        if let Some(home) = cli::home_dir() {
            paths.push(home.join(".local/bin/codex"));
            paths.push(home.join(".codex/bin/codex"));
            paths.push(home.join(".npm-global/bin/codex"));
        }
        paths.push("/opt/homebrew/bin/codex".into());
        paths.push("/usr/local/bin/codex".into());
    }
    cli::find(NAME, paths).ok_or(HarnessError::NotInstalled(NAME))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_binary_is_reported_and_not_installed() {
        let codex = Codex::new(|| Options {
            binary: Some("/nowhere/codex".into()),
        });
        assert!(matches!(codex.exe(), Err(HarnessError::BinaryMissing(_))));
        assert!(!codex.catalog().installed);
        assert!(matches!(codex.run(RunRequest::default()), Err(HarnessError::BinaryMissing(_))));
    }
}
