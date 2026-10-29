//! OpenCode: spawns the installed `opencode` as `opencode serve` (2.x) and
//! speaks its HTTP API, following its event bus, as zeron does.
//!
//! - A run is one server (a free loopback port, a per-run password) holding
//!   one session: `POST /api/session` with the folder, model and permission
//!   rules, or the chat's session when resuming. Each prompt is
//!   `POST /api/session/{id}/prompt`; the bus (`GET /api/event`, every
//!   session's events, subagents' included) carries the turn, which ends
//!   with the session's `session.execution.succeeded` / `.interrupted` /
//!   `.failed`. A prompt sent mid-turn waits for the turn to end.
//! - Frames become events in [`normalize`]: text and reasoning deltas, tool
//!   calls and results, step token counts as context occupancy, a subagent's
//!   child session as [`AgentEvent::Subagent`] events.
//! - Access modes: OpenCode's agents allow nearly everything; restricted
//!   modes add `ask` rules to the session ([`session::permission_rules`]),
//!   and each `permission.asked` is answered by the mode or put to the user
//!   as a yes/no question (`once` / `reject`). The agent's `question` tool
//!   arrives as a form (`form.created`), asked as is.
//! - Plan mode is OpenCode's read-only `plan` agent. A plan turn that ends
//!   with text asks whether to implement it (at once in full access), then
//!   runs "Implement the plan." on the `build` agent in the same reply.
//! - Attachments: paths listed under the prompt, images also as files.
//!   `$skill` mentions ride the prompt's `skills`. A leading `/command` of
//!   the folder's goes to `.../command`, `/compact` to `.../compact`.
//! - Models come from `/api/model` on a server started for it, cached and
//!   refreshed in the background; reasoning levels are the model's variants.
//!
//! [`AgentEvent::Subagent`]: hive_proto::AgentEvent::Subagent

mod models;
mod normalize;
pub(crate) mod provider;
mod server;
mod session;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use hive_proto::{
    AccessMode, AgentEvent, CommandKind, DoneStatus, HarnessCapabilities, HarnessCatalog,
    HarnessId, RunRequest, SlashCommand,
};
use serde_json::json;
use tokio::sync::mpsc;

use crate::claude::find_on_path;
use crate::{Harness, HarnessError, Run, RunHandle};
use models::Models;
use server::Server;

/// How long a model list is used before it's fetched again.
const MODELS_TTL: Duration = Duration::from_secs(10 * 60);
/// How long a folder's commands are reused.
const PROBE_TTL: Duration = Duration::from_secs(30);
const PROBE_TIMEOUT: Duration = Duration::from_secs(60);
/// How long a title may take.
const TITLE_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Default)]
struct ModelState {
    models: Option<Models>,
    fetched: Option<Instant>,
    refreshing: bool,
}

#[derive(Default)]
pub struct OpencodeHarness {
    executable: Option<PathBuf>,
    models: Arc<Mutex<ModelState>>,
    /// Each folder's commands and skills, as a run or probe there listed them.
    commands: Arc<Mutex<HashMap<String, Vec<SlashCommand>>>>,
    probes: Arc<Mutex<HashMap<String, Instant>>>,
}

impl OpencodeHarness {
    pub fn new() -> Self {
        Self::default()
    }

    /// Uses `path` instead of looking `opencode` up on PATH.
    pub fn with_executable(path: impl Into<PathBuf>) -> Self {
        Self {
            executable: Some(path.into()),
            ..Self::default()
        }
    }

    fn exe(&self) -> Option<PathBuf> {
        self.executable.clone().or_else(find_opencode)
    }

    fn listed_models(&self) -> Models {
        self.models
            .lock()
            .unwrap()
            .models
            .clone()
            .unwrap_or_default()
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

/// The models of the providers the user has set up. The list syncs shortly
/// after the server starts; an empty one right then is asked again.
async fn list_models(exe: PathBuf) -> Result<Models, String> {
    let server = Server::start(&exe, "", None).await?;
    let result = fetch_models(&server.api, 5).await;
    server.shutdown().await;
    result
}

/// The model list from a running server, asked up to `attempts` times
/// while it comes back empty.
async fn fetch_models(api: &server::Api, attempts: u32) -> Result<Models, String> {
    let mut models = Models::default();
    for attempt in 0..attempts {
        if attempt > 0 {
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
        let (list, providers, default) = tokio::join!(
            api.get("/api/model"),
            api.get("/api/provider"),
            api.get("/api/model/default"),
        );
        models = models::parse(
            &list?,
            &providers.unwrap_or_default(),
            &default.unwrap_or_default(),
        );
        if !models.models.is_empty() {
            break;
        }
    }
    Ok(models)
}

/// Commands every OpenCode session takes, whatever the folder.
fn builtin_commands() -> Vec<SlashCommand> {
    vec![SlashCommand {
        name: "compact".into(),
        description: "Summarize the conversation to free up context".into(),
        input_hint: None,
        kind: CommandKind::Command,
    }]
}

/// The folder's commands after the built-in ones, without repeats.
fn with_builtins(listed: &[SlashCommand]) -> Vec<SlashCommand> {
    let mut commands = builtin_commands();
    for command in listed {
        if !commands.iter().any(|c| c.name == command.name) {
            commands.push(command.clone());
        }
    }
    commands
}

impl Harness for OpencodeHarness {
    fn id(&self) -> HarnessId {
        HarnessId::Opencode
    }

    fn catalog(&self) -> HarnessCatalog {
        let exe = self.exe();
        if let Some(exe) = &exe {
            self.refresh_models(exe.clone());
        }
        let models = self.listed_models();
        HarnessCatalog {
            id: HarnessId::Opencode,
            label: "OpenCode".into(),
            installed: exe.is_some(),
            default_model: models
                .default
                .filter(|d| models.models.iter().any(|m| &m.id == d))
                .or_else(|| models.models.first().map(|m| m.id.clone())),
            models: models.models,
            commands: builtin_commands(),
            access_modes: AccessMode::ALL.to_vec(),
            capabilities: HarnessCapabilities {
                // A prompt sent mid-turn waits for the turn to end.
                steering: false,
                interrupt: true,
                // Paths listed in the prompt; images also as files.
                attachments: true,
                // The `plan` agent.
                plan: true,
            },
        }
    }

    fn run(&self, request: RunRequest) -> Result<Run, HarnessError> {
        let exe = self.exe().ok_or(HarnessError::NotInstalled("opencode"))?;
        Ok(session::run(session::Launch {
            exe,
            request,
            models: self.listed_models(),
            commands: Arc::clone(&self.commands),
        }))
    }

    /// `/api/command` and `/api/skill` on a server started for it.
    fn commands(&self, cwd: &str) -> crate::CommandsFuture {
        let exe = self.exe();
        let cache = Arc::clone(&self.commands);
        let probes = Arc::clone(&self.probes);
        let cwd = cwd.to_owned();
        Box::pin(async move {
            let fresh = probes
                .lock()
                .unwrap()
                .get(&cwd)
                .is_some_and(|at| at.elapsed() < PROBE_TTL);
            let known = cache.lock().unwrap().get(&cwd).cloned();
            if let (true, Some(known)) = (fresh, &known) {
                return Ok(with_builtins(known));
            }
            let exe = exe.ok_or(HarnessError::NotInstalled("opencode"))?;
            let listed = tokio::time::timeout(PROBE_TIMEOUT, async {
                let server = Server::start(&exe, &cwd, None).await?;
                let listed = session::list_commands(&server.api).await;
                server.shutdown().await;
                listed
            })
            .await
            .map_err(|_| HarnessError::Probe("OpenCode didn't list its commands in time.".into()))?
            .map_err(HarnessError::Probe)?;
            cache.lock().unwrap().insert(cwd.clone(), listed.clone());
            probes.lock().unwrap().insert(cwd, Instant::now());
            Ok(with_builtins(&listed))
        })
    }

    fn supports_titles(&self) -> bool {
        true
    }

    /// One `POST /api/experimental/generate/text`: a single model call, no
    /// session, no tools. It takes no system prompt, so the request (the
    /// title instructions with the chat's first prompt) goes as the prompt.
    fn run_title(&self, request: RunRequest) -> Result<Run, HarnessError> {
        let exe = self.exe().ok_or(HarnessError::NotInstalled("opencode"))?;
        let models = self.listed_models();
        let (events_tx, events) = mpsc::channel(16);
        let (handle, mut commands) = RunHandle::new();
        tokio::spawn(async move {
            let work = async {
                let server = Server::start(&exe, &request.cwd, None).await?;
                let mut body = json!({ "prompt": request.prompt });
                if let Some(model) = session::model_ref(&request, &models) {
                    body["model"] = model;
                }
                let result = server
                    .api
                    .post("/api/experimental/generate/text", &body)
                    .await;
                server.shutdown().await;
                let text = result?["text"].as_str().unwrap_or_default().to_owned();
                Ok::<_, String>(text)
            };
            let outcome = tokio::select! {
                outcome = tokio::time::timeout(TITLE_TIMEOUT, work) => outcome
                    .unwrap_or_else(|_| Err("OpenCode didn't write a title in time.".into())),
                // Closed or interrupted before it was done.
                _ = async {
                    while let Some(command) = commands.recv().await {
                        if matches!(command, crate::RunCommand::Interrupt | crate::RunCommand::Close) {
                            return;
                        }
                    }
                } => Err("Stopped.".into()),
            };
            let done = match outcome {
                Ok(text) => {
                    if !text.trim().is_empty() {
                        let _ = events_tx.send(AgentEvent::TextDelta { text }).await;
                    }
                    AgentEvent::Done {
                        status: DoneStatus::Completed,
                        error: None,
                        session_id: None,
                    }
                }
                Err(error) => AgentEvent::Done {
                    status: DoneStatus::Errored,
                    error: Some(error),
                    session_id: None,
                },
            };
            let _ = events_tx.send(done).await;
        });
        Ok(Run { events, handle })
    }
}

/// `opencode` on PATH, else where its installers put it. An app started from
/// Finder or the Start menu may not see the shell's PATH.
pub(crate) fn find_opencode() -> Option<PathBuf> {
    find_on_path("opencode").or_else(|| install_locations().into_iter().find(|p| p.is_file()))
}

fn install_locations() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    let exe = if cfg!(windows) { "opencode.exe" } else { "opencode" };
    if let Some(home) = server::home_dir() {
        for dir in [".opencode/bin", ".local/bin", ".bun/bin", ".npm-global/bin"] {
            paths.push(home.join(dir).join(exe));
        }
    }
    if cfg!(windows) {
        if let Some(appdata) = std::env::var_os("APPDATA") {
            paths.push(PathBuf::from(appdata).join(r"npm\opencode.cmd"));
        }
    } else {
        paths.push("/opt/homebrew/bin/opencode".into());
        paths.push("/usr/local/bin/opencode".into());
    }
    paths
}
