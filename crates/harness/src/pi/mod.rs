//! Pi (`pi.dev`): spawns the installed `pi` as `pi --mode rpc` and speaks its
//! JSONL protocol over stdin/stdout ([`session`]).
//!
//! - A run is one process holding one Pi session; resuming passes the chat's
//!   session id as `--session-id`. Each prompt is a `prompt` command and runs
//!   until `agent_settled`; one sent mid-turn waits for it.
//! - Events become [`AgentEvent`]s in [`normalize`]: text and thinking
//!   deltas, tool calls and results (edits with their diff), token usage as
//!   context occupancy, compactions.
//! - Access modes: Pi asks nothing itself. Hive's extension (`extension.mjs`,
//!   loaded with `-e`) holds back every tool call the mode doesn't cover and
//!   asks through a `confirm` dialog, which Hive puts to the user. It also
//!   bridges Hive's MCP server, whose tools Pi sees as `mcp__hive__<tool>`.
//! - No plan mode. Attachments: paths listed under the prompt, images inline
//!   when the model takes them. `$skill` → `/skill:name`; `/compact` → Pi's
//!   `compact`; other `/commands` (extensions', prompt templates) go as is.
//! - Models come from `get_available_models` on a process started for it,
//!   cached and refreshed in the background; levels as Pi offers them.
//!
//! [`AgentEvent`]: hive_proto::AgentEvent

mod commands;
mod models;
mod normalize;
pub(crate) mod provider;
mod session;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use hive_proto::{
    AccessMode, HarnessCapabilities, HarnessCatalog, HarnessId, RunRequest, SlashCommand,
};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, BufReader};

use crate::models::ModelCache;
use crate::{cli, Harness, HarnessError, Run};
use models::Models;

/// How long a folder's commands are reused.
const PROBE_TTL: Duration = Duration::from_secs(30);
const PROBE_TIMEOUT: Duration = Duration::from_secs(60);

const EXTENSION: &str = include_str!("extension.mjs");

#[derive(Default)]
pub struct PiHarness {
    models: ModelCache<Models>,
    commands: Arc<Mutex<HashMap<String, Vec<SlashCommand>>>>,
    probes: Arc<Mutex<HashMap<String, Instant>>>,
}

impl PiHarness {
    pub fn new() -> Self {
        Self::default()
    }

    fn launch(&self, request: RunRequest, title: bool) -> Result<Run, HarnessError> {
        let exe = find_pi().ok_or(HarnessError::NotInstalled("pi"))?;
        session::run(session::Launch {
            exe,
            request,
            title,
            extension: if title { None } else { extension() },
            commands: Arc::clone(&self.commands),
        })
    }
}

impl Harness for PiHarness {
    fn id(&self) -> HarnessId {
        HarnessId::Pi
    }

    fn catalog(&self) -> HarnessCatalog {
        let exe = find_pi();
        if let Some(exe) = &exe {
            self.models
                .refresh(PROBE_TIMEOUT, list_models(exe.clone()), |m| !m.models.is_empty());
        }
        let models = self.models.get().unwrap_or_default();
        HarnessCatalog {
            id: HarnessId::Pi,
            label: "Pi".into(),
            installed: exe.is_some(),
            default_model: models
                .default
                .filter(|d| models.models.iter().any(|m| &m.id == d))
                .or_else(|| models.models.first().map(|m| m.id.clone())),
            models: models.models,
            commands: commands::builtin(),
            access_modes: AccessMode::ALL.to_vec(),
            capabilities: HarnessCapabilities {
                // A prompt sent mid-turn waits for the turn to end.
                steering: false,
                interrupt: true,
                attachments: true,
                plan: false,
            },
        }
    }

    fn run(&self, request: RunRequest) -> Result<Run, HarnessError> {
        self.launch(request, false)
    }

    /// `get_commands` from a process started in `cwd` for it.
    fn commands(&self, cwd: &str) -> crate::CommandsFuture {
        let exe = find_pi();
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
                return Ok(commands::with_builtins(known));
            }
            let exe = exe.ok_or(HarnessError::NotInstalled("pi"))?;
            let answers = probe(&exe, &cwd, &[json!({"type": "get_commands"})])
                .await
                .map_err(HarnessError::Probe)?;
            let listed = commands::parse(&answers[0]);
            cache.lock().unwrap().insert(cwd.clone(), listed.clone());
            probes.lock().unwrap().insert(cwd, Instant::now());
            Ok(commands::with_builtins(&listed))
        })
    }

    fn supports_titles(&self) -> bool {
        true
    }

    /// One turn with no tools, skills, context files or session, under
    /// [`crate::TEXT_INSTRUCTIONS`].
    fn run_title(&self, request: RunRequest) -> Result<Run, HarnessError> {
        self.launch(crate::title_request(request), true)
    }
}

/// Pi's models and its default, from a process started for it.
async fn list_models(exe: PathBuf) -> Result<Models, String> {
    let answers = probe(
        &exe,
        "",
        &[json!({"type": "get_state"}), json!({"type": "get_available_models"})],
    )
    .await?;
    Ok(Models {
        default: models::model_id(&answers[0]["model"]),
        models: models::parse(&answers[1]),
    })
}

/// Starts `pi --mode rpc --no-session` in `cwd` (home when empty), sends
/// `requests` and returns their answers' `data`, in order.
async fn probe(exe: &Path, cwd: &str, requests: &[Value]) -> Result<Vec<Value>, String> {
    let mut cmd = crate::overrides::command(HarnessId::Pi, exe);
    cmd.args(["--mode", "rpc", "--no-session"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(false);
    let dir = if cwd.is_empty() {
        cli::home_dir()
    } else {
        Some(cwd.into())
    };
    if let Some(dir) = dir.filter(|d| d.is_dir()) {
        cmd.current_dir(dir);
    }
    #[cfg(unix)]
    cmd.process_group(0);
    let mut child = cmd.spawn().map_err(|e| format!("Couldn't start pi: {e}"))?;
    let stdin = child.stdin.take().expect("piped stdin");
    let mut lines = BufReader::new(child.stdout.take().expect("piped stdout")).lines();
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    for (i, request) in requests.iter().enumerate() {
        let mut request = request.clone();
        request["id"] = format!("hive_probe_{i}").into();
        let _ = tx.send(request.to_string());
    }
    // Kept open until every answer is in: closing stdin ends Pi.
    let writer = tokio::spawn(cli::write_stdin(stdin, rx));
    let answers = tokio::time::timeout(PROBE_TIMEOUT, async {
        let mut answers = vec![Value::Null; requests.len()];
        let mut left = requests.len();
        while let Ok(Some(line)) = lines.next_line().await {
            let Ok(frame) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            let Some(i) = frame["id"]
                .as_str()
                .and_then(|id| id.strip_prefix("hive_probe_"))
                .and_then(|i| i.parse::<usize>().ok())
                .filter(|i| *i < answers.len())
            else {
                continue;
            };
            if frame["success"] != true {
                return Err(frame["error"].as_str().unwrap_or("Pi refused the request.").to_owned());
            }
            answers[i] = frame["data"].clone();
            left -= 1;
            if left == 0 {
                return Ok(answers);
            }
        }
        Err("pi exited before answering.".to_owned())
    })
    .await
    .unwrap_or_else(|_| Err("Pi didn't answer in time.".into()));
    drop(tx);
    writer.abort();
    if tokio::time::timeout(cli::EXIT_GRACE, child.wait()).await.is_err() {
        cli::kill_tree(&mut child).await;
    }
    answers
}

/// Hive's extension, written out once per launch of Hive (Pi loads it from
/// a file). None if it can't be written: the run goes without it.
fn extension() -> Option<PathBuf> {
    static PATH: OnceLock<Option<PathBuf>> = OnceLock::new();
    PATH.get_or_init(|| {
        let hash = EXTENSION
            .bytes()
            .fold(0xcbf2_9ce4_8422_2325u64, |h, b| (h ^ b as u64).wrapping_mul(0x100_0000_01b3));
        let path = std::env::temp_dir().join(format!("hive-pi-{hash:016x}.mjs"));
        let current = std::fs::read_to_string(&path).is_ok_and(|text| text == EXTENSION);
        (current || std::fs::write(&path, EXTENSION).is_ok()).then_some(path)
    })
    .clone()
}

/// `pi` on PATH, else where its installers put it.
pub(crate) fn find_pi() -> Option<PathBuf> {
    crate::overrides::binary(HarnessId::Pi, found_pi)
}

fn found_pi() -> Option<PathBuf> {
    let mut paths = Vec::new();
    let exe = if cfg!(windows) { "pi.cmd" } else { "pi" };
    if let Some(home) = cli::home_dir() {
        // pi.dev's installer, then bun's and npm's usual global folders.
        for dir in [".pi/agent/bin", ".bun/bin", ".local/bin", ".npm-global/bin"] {
            paths.push(home.join(dir).join(exe));
        }
    }
    if cfg!(windows) {
        if let Some(appdata) = std::env::var_os("APPDATA") {
            paths.push(PathBuf::from(appdata).join(r"npm\pi.cmd"));
        }
    } else {
        paths.push("/opt/homebrew/bin/pi".into());
        paths.push("/usr/local/bin/pi".into());
    }
    cli::find("pi", paths)
}
