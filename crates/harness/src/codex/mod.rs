//! Codex: spawns the installed `codex` CLI as `codex app-server` and speaks
//! its JSON-RPC protocol over stdin/stdout, as zeron does.
//!
//! - A run is one app-server holding one thread: `thread/start` (or
//!   `thread/resume` with the chat's thread id; a thread that can't be
//!   resumed is replaced by a new one, with a note), then `turn/start` per
//!   prompt. A prompt sent mid-turn waits for the turn to end.
//! - Notifications become events in [`normalize`]: agent messages and plans
//!   as text, reasoning summaries, commands / file changes / MCP calls /
//!   web searches as tool calls, `turn/plan/updated` as a todo list, token
//!   usage as context occupancy, a spawned subagent's thread as
//!   [`AgentEvent::Subagent`] events.
//! - Access modes: full access runs with `approvalPolicy: never`; the others
//!   with `untrusted`, and the server's approval requests are answered here
//!   by the mode (auto-accept edits accepts file changes) or asked of the
//!   user as yes/no questions ([`crate::approval`]). `item/tool/requestUserInput`
//!   (the model's own questions) is asked as is. `auto_approve` adds the
//!   `danger-full-access` sandbox; otherwise the chat's sandbox level holds.
//! - Plan mode is Codex's `plan` collaboration mode, named on every turn. A
//!   plan-mode turn that ends with a plan asks whether to implement it (at
//!   once in full access), then runs "Implement the plan." in default mode
//!   within the same reply, as Claude's `ExitPlanMode` does.
//! - Attachments: paths listed under the prompt, images also as
//!   `localImage` inputs. `$skill` mentions add `skill` inputs. `/compact`
//!   and `/review [instructions]` become `thread/compact/start` and
//!   `review/start`.
//! - Interrupt is `turn/interrupt`; a turn that doesn't report its end
//!   within a few seconds is reported interrupted anyway.
//! - Models come from `model/list`, cached and refreshed in the background;
//!   until the first answer, from the CLI's own `models_cache.json`.
//!
//! [`AgentEvent::Subagent`]: hive_proto::AgentEvent::Subagent

mod models;
mod normalize;
pub(crate) mod provider;
mod rpc;
mod session;
mod skills;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use hive_proto::{AccessMode, HarnessCapabilities, HarnessCatalog, HarnessId, RunRequest};
use serde_json::json;

use crate::claude::find_on_path;
use crate::{Harness, HarnessError, Run};
use models::Models;
use rpc::Server;
use skills::Skill;

/// How long a model list is used before it's fetched again.
const MODELS_TTL: Duration = Duration::from_secs(10 * 60);
/// How long a skills probe's answer is reused for the same folder.
const PROBE_TTL: Duration = Duration::from_secs(30);
const PROBE_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Default)]
struct ModelState {
    models: Option<Models>,
    fetched: Option<Instant>,
    refreshing: bool,
}

#[derive(Default)]
pub struct CodexHarness {
    executable: Option<PathBuf>,
    models: Arc<Mutex<ModelState>>,
    /// Each folder's skills, as the last run or probe there listed them.
    skills: Arc<Mutex<HashMap<String, Vec<Skill>>>>,
    probes: Arc<Mutex<HashMap<String, Instant>>>,
}

impl CodexHarness {
    pub fn new() -> Self {
        Self::default()
    }

    /// Uses `path` instead of looking `codex` up on PATH.
    pub fn with_executable(path: impl Into<PathBuf>) -> Self {
        Self {
            executable: Some(path.into()),
            ..Self::default()
        }
    }

    fn exe(&self) -> Option<PathBuf> {
        self.executable.clone().or_else(find_codex)
    }

    /// A level the model doesn't offer becomes the closest one it does
    /// (the next higher, else the highest): Codex refuses the rest. The
    /// title run asks for `minimal`, which most models lack.
    fn fit_reasoning(&self, request: &mut RunRequest) {
        let (Some(level), Some(model)) = (request.reasoning, &request.model) else {
            return;
        };
        let listed = self.models.lock().unwrap().models.clone();
        let Some(models) = listed.or_else(models::from_cache) else {
            return;
        };
        let Some(offered) = models.models.iter().find(|m| &m.id == model) else {
            return;
        };
        request.reasoning = models::closest_level(&offered.reasoning_levels, level);
    }

    /// Fetches the model list in the background when it's missing or old.
    fn refresh_models(&self, exe: PathBuf) {
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            return;
        };
        {
            let mut state = self.models.lock().unwrap();
            let fresh = state.fetched.is_some_and(|at| at.elapsed() < MODELS_TTL);
            if fresh || state.refreshing {
                return;
            }
            state.refreshing = true;
        }
        let state = Arc::clone(&self.models);
        runtime.spawn(async move {
            let listed = tokio::time::timeout(PROBE_TIMEOUT, list_models(exe)).await;
            let mut state = state.lock().unwrap();
            state.refreshing = false;
            // A failure waits out the TTL too, rather than starting a server
            // per catalog call.
            state.fetched = Some(Instant::now());
            if let Ok(Ok(models)) = listed {
                if !models.models.is_empty() {
                    state.models = Some(models);
                }
            }
        });
    }
}

/// Every page of `model/list`.
async fn list_models(exe: PathBuf) -> Result<Models, String> {
    let server = Server::start(&exe, "").await.map_err(|e| e.to_string())?;
    let mut data = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let result = server
            .client
            .request("model/list", json!({ "cursor": cursor }))
            .await?;
        data.extend(result["data"].as_array().cloned().unwrap_or_default());
        cursor = result["nextCursor"].as_str().map(str::to_owned);
        if cursor.is_none() {
            break;
        }
    }
    Ok(models::from_list(&data))
}

impl Harness for CodexHarness {
    fn id(&self) -> HarnessId {
        HarnessId::Codex
    }

    fn catalog(&self) -> HarnessCatalog {
        let exe = self.exe();
        if let Some(exe) = &exe {
            self.refresh_models(exe.clone());
        }
        let listed = self.models.lock().unwrap().models.clone();
        let models = listed.or_else(models::from_cache).unwrap_or_default();
        HarnessCatalog {
            id: HarnessId::Codex,
            label: "Codex".into(),
            installed: exe.is_some(),
            default_model: models
                .default
                .or_else(|| models.models.first().map(|m| m.id.clone())),
            models: models.models,
            commands: skills::builtin(),
            access_modes: AccessMode::ALL.to_vec(),
            capabilities: HarnessCapabilities {
                // A prompt sent mid-turn waits for the turn to end.
                steering: false,
                interrupt: true,
                // Paths listed in the prompt; images also as `localImage`.
                attachments: true,
                // The `plan` collaboration mode.
                plan: true,
            },
        }
    }

    fn run(&self, mut request: RunRequest) -> Result<Run, HarnessError> {
        let exe = self.exe().ok_or(HarnessError::NotInstalled("codex"))?;
        self.fit_reasoning(&mut request);
        Ok(session::run(session::Launch {
            exe,
            request,
            title: false,
            skills: Arc::clone(&self.skills),
        }))
    }

    /// `skills/list` on an app-server started for it.
    fn commands(&self, cwd: &str) -> crate::CommandsFuture {
        let exe = self.exe();
        let skills = Arc::clone(&self.skills);
        let probes = Arc::clone(&self.probes);
        let cwd = cwd.to_owned();
        Box::pin(async move {
            let fresh = probes
                .lock()
                .unwrap()
                .get(&cwd)
                .is_some_and(|at| at.elapsed() < PROBE_TTL);
            let known = skills.lock().unwrap().get(&cwd).cloned();
            if let (true, Some(known)) = (fresh, &known) {
                return Ok(skills::commands(known));
            }
            let exe = exe.ok_or(HarnessError::NotInstalled("codex"))?;
            let result = Server::one_shot(
                &exe,
                &cwd,
                "skills/list",
                json!({ "cwds": [cwd] }),
                PROBE_TIMEOUT,
            )
            .await
            .map_err(HarnessError::Probe)?;
            let listed = skills::parse(&result);
            skills.lock().unwrap().insert(cwd.clone(), listed.clone());
            probes.lock().unwrap().insert(cwd, Instant::now());
            Ok(skills::commands(&listed))
        })
    }

    fn supports_titles(&self) -> bool {
        true
    }

    /// An ephemeral, read-only thread with the title instructions as its
    /// base instructions; anything it asks is refused.
    fn run_title(&self, mut request: RunRequest) -> Result<Run, HarnessError> {
        let exe = self.exe().ok_or(HarnessError::NotInstalled("codex"))?;
        request.resume = None;
        request.attachments.clear();
        request.model_options.clear();
        request.auto_approve = false;
        request.access = AccessMode::Supervised;
        request.plan = false;
        self.fit_reasoning(&mut request);
        Ok(session::run(session::Launch {
            exe,
            request,
            title: true,
            skills: Arc::clone(&self.skills),
        }))
    }
}

/// `codex` on PATH, else where its installers put it. An app started from
/// Finder or the Start menu may not see the shell's PATH.
pub(crate) fn find_codex() -> Option<PathBuf> {
    find_on_path("codex").or_else(|| install_locations().into_iter().find(|p| p.is_file()))
}

fn install_locations() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    let home =
        std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from);
    if cfg!(windows) {
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            paths.push(PathBuf::from(local).join(r"Programs\OpenAI\Codex\bin\codex.exe"));
        }
        if let Some(appdata) = std::env::var_os("APPDATA") {
            paths.push(PathBuf::from(appdata).join(r"npm\codex.cmd"));
        }
    } else {
        if let Some(home) = &home {
            paths.push(home.join(".local/bin/codex"));
            paths.push(home.join(".codex/bin/codex"));
            paths.push(home.join(".npm-global/bin/codex"));
        }
        paths.push("/opt/homebrew/bin/codex".into());
        paths.push("/usr/local/bin/codex".into());
    }
    paths
}
