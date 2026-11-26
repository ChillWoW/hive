//! Claude Code: spawns the installed `claude` CLI and speaks its stream-json
//! protocol over stdin/stdout.
//!
//! - The session opens with an `initialize` control request, whose answer
//!   lists the commands and skills ([`commands`]); the first prompt waits for
//!   it (or [`INITIALIZE_WAIT`]). Each turn is a user line on stdin (`$skill`
//!   rewritten to what Claude takes, attachments listed under the prompt and
//!   images inline) and ends with the CLI's `result` frame. The process stays
//!   up between turns until stdin closes.
//! - Permissions ride the control channel (`--permission-prompt-tool stdio`):
//!   the CLI sends `can_use_tool` and waits for the answer. The access mode
//!   decides what's asked ([`approval`]); `AskUserQuestion` and plan mode's
//!   `ExitPlanMode` are always asked. Each becomes an
//!   [`AgentEvent::InputRequested`] keyed by the CLI's request id.
//! - Access and plan mode map onto `--permission-mode`, and change in place
//!   (`set_permission_mode`). Approving a plan leaves plan mode for the
//!   access mode.
//! - Interrupt sends the `interrupt` control request: the turn ends with an
//!   interrupted `result` and the process keeps running. One that doesn't
//!   report within [`INTERRUPT_SETTLE`] is ended by the run itself.
//!   Background agents and shells survive it (`perTaskStopAffordance`) and
//!   are stopped one by one (`stop_task`).
//! - When background work ends between turns the CLI starts a turn on its
//!   own (a `system:init` with no prompt in flight): that's
//!   [`AgentEvent::BackgroundTurn`].
//! - ⚠ The process is never stopped while a login refresh is in flight
//!   ([`refresh_lock`]): stdin closes, and a kill happens, only once it has
//!   settled.

mod approval;
mod commands;
mod models;
mod normalize;
mod overrides;
pub mod provider;
mod refresh_lock;
mod wire;

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use outcode_proto::{
    AccessMode, AgentEvent, ApprovalDecision, ChatConfig, DoneStatus, InputResponse, RunRequest,
    SlashCommand, UserInputAnswer, UserInputQuestion,
};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWriteExt, BufReader, Lines};
use tokio::process::{Child, ChildStdout};
use tokio::sync::mpsc;
use tokio::time::Instant;

use crate::attachments;
use crate::cli::{self, StderrTail, sleep_until};
use crate::{Gone, HarnessError, Run, RunCommand, RunHandle};
use approval::Pending;
use models::config_args;
use normalize::Normalizer;
use wire::{ControlRequestFrame, Frame};

pub use models::catalog;
pub use overrides::configure;

const NAME: &str = "claude";
const INITIALIZE_ID: &str = "outcode_initialize";
/// Asked once `initialize` answers: the context window, before the first
/// turn's `result` would report it.
const CONTEXT_USAGE_ID: &str = "outcode_context_usage";
/// How long the first prompt waits on the `initialize` response.
const INITIALIZE_WAIT: Duration = Duration::from_secs(5);
/// How long an interrupted turn may take to report its end before the run
/// reports it interrupted anyway.
const INTERRUPT_SETTLE: Duration = Duration::from_secs(5);
/// How long a command probe may take, and how long its answer is reused for
/// the same folder.
const PROBE_TIMEOUT: Duration = Duration::from_secs(20);
const PROBE_TTL: Duration = Duration::from_secs(60);

/// The skills' names from the last `system:init` any run saw: the
/// `initialize` list doesn't say which commands are skills.
static KNOWN_SKILLS: LazyLock<Mutex<Option<HashSet<String>>>> = LazyLock::new(Mutex::default);
/// The last probe's command list per folder.
type Probed = (std::time::Instant, Vec<commands::Advertised>);
static PROBES: LazyLock<Mutex<HashMap<String, Probed>>> =
    LazyLock::new(Mutex::default);

/// The `claude` binary: `binary` when given, else on PATH or where its
/// installers put it.
pub fn find(binary: Option<&Path>) -> Result<PathBuf, HarnessError> {
    if let Some(binary) = binary {
        return if binary.is_file() {
            Ok(binary.to_owned())
        } else {
            Err(HarnessError::BinaryMissing(binary.display().to_string()))
        };
    }
    let home = cli::home_dir();
    let mut paths = Vec::new();
    if cfg!(windows) {
        if let Some(home) = &home {
            paths.push(home.join(r".local\bin\claude.exe"));
        }
        if let Some(appdata) = std::env::var_os("APPDATA") {
            paths.push(PathBuf::from(appdata).join(r"npm\claude.cmd"));
        }
    } else {
        if let Some(home) = &home {
            paths.push(home.join(".local/bin/claude"));
            paths.push(home.join(".claude/local/claude"));
        }
        paths.push("/opt/homebrew/bin/claude".into());
        paths.push("/usr/local/bin/claude".into());
    }
    cli::find(NAME, paths).ok_or(HarnessError::NotInstalled(NAME))
}

const ARGS: [&str; 7] = [
    "--print",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    // Required alongside `--print --output-format stream-json`.
    "--verbose",
    "--include-partial-messages",
];

/// The CLI permission mode an access mode works in. Full access stays in
/// `default` and allows every call when asked, so no run launches with a
/// skip-permissions flag (the CLI refuses those as root outside a sandbox).
fn access_permission_mode(access: AccessMode) -> &'static str {
    match access {
        AccessMode::AutoAcceptEdits => "acceptEdits",
        AccessMode::Supervised | AccessMode::FullAccess => "default",
    }
}

fn permission_mode(access: AccessMode, plan: bool) -> &'static str {
    if plan { "plan" } else { access_permission_mode(access) }
}

/// Starts a `claude` session (`binary`, or the one [`find`] finds) with
/// `request.prompt` as its first turn. Must be called from inside a tokio
/// runtime.
pub fn run(request: RunRequest, binary: Option<&Path>) -> Result<Run, HarnessError> {
    start(request, binary, false)
}

/// Starts a one-turn text run (a chat title, a branch name) that answers
/// `prompt` with `model` (the CLI's default when `None`): [`TEXT_INSTRUCTIONS`]
/// as its system prompt, no tools, MCP servers or settings, nothing saved,
/// and no `initialize` round trip. It runs in an empty scratch folder, so no
/// project instructions apply. Close it once its turn is done.
///
/// [`TEXT_INSTRUCTIONS`]: crate::TEXT_INSTRUCTIONS
pub fn run_text(prompt: String, model: Option<&str>, binary: Option<&Path>) -> Result<Run, HarnessError> {
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
    start(request, binary, true)
}

/// The launch flags beyond [`ARGS`] for a chat's run.
fn launch_args(request: &RunRequest) -> Vec<String> {
    let mut args: Vec<String> = vec![
        // Routes `can_use_tool` (and `AskUserQuestion` with it) to us.
        "--permission-prompt-tool".into(),
        "stdio".into(),
        "--permission-mode".into(),
        permission_mode(request.config.access, request.config.plan).into(),
    ];
    if let Some(session) = request.resume.as_deref().filter(|s| !s.is_empty()) {
        args.extend(["--resume".into(), session.into()]);
    }
    args.extend(config_args(&request.config, request.auto_compact_window));
    // Beside the user's own servers: the CLI merges an inline config with them.
    if let Some(mcp) = &request.mcp {
        args.extend(["--mcp-config".into(), mcp_config_arg(mcp)]);
    }
    args
}

/// `text`: a [`run_text`] run.
fn start(request: RunRequest, binary: Option<&Path>, text: bool) -> Result<Run, HarnessError> {
    let exe = find(binary)?;
    let mut cmd = overrides::command(&exe);
    cmd.args(ARGS)
        // Set when Outcode itself runs inside Claude Code; the child would
        // otherwise think it's nested.
        .env_remove("CLAUDECODE")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(cwd) = working_dir(&request.cwd) {
        cmd.current_dir(cwd);
    }
    if text {
        cmd.args(config_args(&request.config, None));
        cmd.args([
            "--system-prompt",
            crate::TEXT_INSTRUCTIONS,
            "--tools",
            "",
            "--mcp-config",
            r#"{"mcpServers":{}}"#,
            "--setting-sources",
            "",
            "--no-session-persistence",
        ]);
        // An administrator's managed MCP config decides which servers run.
        if !managed_mcp_config() {
            cmd.arg("--strict-mcp-config");
        }
    } else {
        cmd.args(launch_args(&request));
        cmd.args(overrides::launch_args());
    }
    let mut child = cmd.spawn().map_err(|e| HarnessError::Spawn(NAME, e))?;
    let stdin = child.stdin.take().expect("piped stdin");
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = StderrTail::collect(child.stderr.take().expect("piped stderr"));

    let (stdin_tx, stdin_rx) = mpsc::unbounded_channel::<String>();
    tokio::spawn(cli::write_stdin(stdin, stdin_rx));
    if !text {
        let _ = stdin_tx.send(wire::initialize_line(INITIALIZE_ID));
    }

    let (events_tx, events) = mpsc::channel(256);
    let (handle, commands) = RunHandle::new();
    let session = Session {
        child,
        stdout: BufReader::new(stdout).lines(),
        stdin: Some(stdin_tx),
        commands,
        events: events_tx,
        normalizer: Normalizer::default(),
        stderr,
        turns: 1,
        interrupts_sent: 0,
        controls_sent: 0,
        interrupt_deadline: None,
        first: Some((request.prompt, request.attachments)),
        // A text run needs nothing `initialize` reports.
        first_deadline: (!text).then(|| Instant::now() + INITIALIZE_WAIT),
        pending: HashMap::new(),
        access: request.config.access,
        plan: request.config.plan,
        allowed: HashSet::new(),
        attachments: HashSet::new(),
        advertised: Vec::new(),
        listed: Vec::new(),
    };
    tokio::spawn(session.run());
    Ok(Run { events, handle })
}

/// Where a run works: `cwd`, else the home folder.
fn working_dir(cwd: &str) -> Option<PathBuf> {
    match cwd.trim() {
        "" => cli::home_dir(),
        cwd => Some(PathBuf::from(cwd)),
    }
}

/// An administrator's `managed-mcp.json`, which the CLI insists on.
fn managed_mcp_config() -> bool {
    let path = if cfg!(target_os = "macos") {
        "/Library/Application Support/ClaudeCode/managed-mcp.json"
    } else if cfg!(windows) {
        r"C:\Program Files\ClaudeCode\managed-mcp.json"
    } else {
        "/etc/claude-code/managed-mcp.json"
    };
    Path::new(path).is_file()
}

/// The commands and skills Claude offers in `cwd`, for the composer before a
/// chat's run has listed them: a CLI started just for its `initialize`
/// answer (no prompt, so no model turn and no MCP servers), then stopped.
/// Reused for a minute per folder.
pub async fn commands(cwd: &str, binary: Option<&Path>) -> Result<Vec<SlashCommand>, HarnessError> {
    let cached = PROBES
        .lock()
        .unwrap()
        .get(cwd)
        .filter(|(at, _)| at.elapsed() < PROBE_TTL)
        .map(|(_, advertised)| advertised.clone());
    let advertised = match cached {
        Some(advertised) => advertised,
        None => {
            let advertised = probe(&find(binary)?, cwd).await?;
            PROBES
                .lock()
                .unwrap()
                .insert(cwd.to_owned(), (std::time::Instant::now(), advertised.clone()));
            advertised
        }
    };
    let known = KNOWN_SKILLS.lock().unwrap();
    Ok(commands::classify(&advertised, known.as_ref()))
}

async fn probe(exe: &Path, cwd: &str) -> Result<Vec<commands::Advertised>, HarnessError> {
    let mut cmd = overrides::command(exe);
    cmd.args(&ARGS[..6]).args(["--mcp-config", r#"{"mcpServers":{}}"#]);
    if !managed_mcp_config() {
        cmd.arg("--strict-mcp-config");
    }
    cmd.env_remove("CLAUDECODE")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    if let Some(cwd) = working_dir(cwd) {
        cmd.current_dir(cwd);
    }
    let mut child = cmd.spawn().map_err(|e| HarnessError::Spawn(NAME, e))?;
    // Kept open until the answer: closing stdin ends the CLI first.
    let mut stdin = child.stdin.take().expect("piped stdin");
    let mut lines = BufReader::new(child.stdout.take().expect("piped stdout")).lines();
    let answer = tokio::time::timeout(PROBE_TIMEOUT, async {
        let mut line = wire::initialize_line(INITIALIZE_ID);
        line.push('\n');
        stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|e| HarnessError::Spawn(NAME, e))?;
        while let Ok(Some(line)) = lines.next_line().await {
            let Ok(Frame::ControlResponse(response)) = wire::parse_frame(line.trim()) else {
                continue;
            };
            if response.response.request_id != INITIALIZE_ID {
                continue;
            }
            let list = response.response.response.get("commands").and_then(Value::as_array);
            return Ok(list.map(|l| commands::parse(l)).unwrap_or_default());
        }
        Err(HarnessError::Probe("Claude exited before listing its commands.".into()))
    })
    .await;
    // It answers before a login refresh it started is saved.
    retire(child, stdin, lines.into_inner());
    answer.unwrap_or_else(|_| Err(HarnessError::Probe("Claude didn't list its commands.".into())))
}

struct Session {
    child: Child,
    stdout: Lines<BufReader<ChildStdout>>,
    /// Lines for the CLI; `None` once closing.
    stdin: Option<mpsc::UnboundedSender<String>>,
    commands: mpsc::UnboundedReceiver<RunCommand>,
    events: mpsc::Sender<AgentEvent>,
    normalizer: Normalizer,
    stderr: StderrTail,
    /// Prompts written (or held) whose turn hasn't ended yet.
    turns: usize,
    interrupts_sent: u64,
    /// Our own control requests, for unique ids.
    controls_sent: u64,
    /// Set while an interrupt waits for its turn to end.
    interrupt_deadline: Option<Instant>,
    /// The first prompt and its files, held until `initialize` answers.
    first: Option<(String, Vec<String>)>,
    first_deadline: Option<Instant>,
    /// `can_use_tool` requests waiting on the user, by request id.
    pending: HashMap<String, Pending>,
    /// What tool calls may do without asking.
    access: AccessMode,
    /// Turns start in plan mode.
    plan: bool,
    /// Calls the user allowed for the rest of the session ([`approval::key`]).
    allowed: HashSet<String>,
    /// Paths of every file sent this session: reading one never asks.
    attachments: HashSet<String>,
    /// The CLI's command list, as last given.
    advertised: Vec<commands::Advertised>,
    /// The commands as last reported.
    listed: Vec<SlashCommand>,
}

impl Session {
    async fn run(mut self) {
        if self.first_deadline.is_none() {
            self.write_first().await;
        }
        let mut commands_open = true;
        loop {
            let outcome = tokio::select! {
                line = self.stdout.next_line() => match line {
                    Ok(Some(line)) => self.on_line(&line).await,
                    // EOF or a broken pipe: the process is exiting.
                    Ok(None) | Err(_) => break,
                },
                command = self.commands.recv(), if commands_open => match command {
                    Some(command) => self.on_command(command).await,
                    None => {
                        // Every handle dropped.
                        commands_open = false;
                        self.close_stdin();
                        Ok(())
                    }
                },
                _ = sleep_until(self.interrupt_deadline) => self.end_turn(DoneStatus::Interrupted).await,
                _ = sleep_until(self.first_deadline) => {
                    self.write_first().await;
                    Ok(())
                }
            };
            if outcome.is_err() {
                // Nobody listens any more.
                let Session {
                    child, stdin, stdout, ..
                } = self;
                retire(child, stdin, stdout.into_inner());
                return;
            }
        }
        self.finish().await;
    }

    async fn on_line(&mut self, line: &str) -> Result<(), Gone> {
        let Ok(frame) = wire::parse_frame(line.trim()) else {
            return Ok(()); // Not JSON: stray CLI output.
        };
        match frame {
            Frame::ControlRequest(request) => self.on_control_request(request).await,
            Frame::ControlResponse(response) => {
                let body = response.response;
                if body.request_id == INITIALIZE_ID {
                    if let Some(list) = body.response.get("commands").and_then(Value::as_array) {
                        self.advertised = commands::parse(list);
                    }
                    self.write(wire::context_usage_line(CONTEXT_USAGE_ID));
                    self.write_first().await;
                    self.report_commands().await?;
                } else if body.request_id == CONTEXT_USAGE_ID
                    && let Some(window) = wire::context_usage_window(&body.response)
                {
                    self.emit(AgentEvent::ContextUsage {
                        tokens: None,
                        window: Some(window),
                    })
                    .await?;
                }
                Ok(())
            }
            Frame::System(f) if f.subtype == "commands_changed" => {
                if let Some(list) = &f.commands {
                    self.advertised = commands::parse(list);
                    self.report_commands().await?;
                }
                Ok(())
            }
            // Nothing in flight: what's left of a turn already reported
            // ended (an interrupt that settled without it).
            Frame::Result(_) if self.turns == 0 => Ok(()),
            frame => {
                if let Frame::System(f) = &frame
                    && f.subtype == "init"
                {
                    if let Some(skills) = &f.skills {
                        *KNOWN_SKILLS.lock().unwrap() = Some(skills.iter().cloned().collect());
                        self.report_commands().await?;
                    }
                    // A turn we didn't start: background work ended between
                    // turns and the CLI woke the model on its own.
                    if self.turns == 0 && self.stdin.is_some() {
                        self.turns = 1;
                        let finished = self.normalizer.start_background_turn();
                        self.emit(AgentEvent::BackgroundTurn { finished }).await?;
                    }
                }
                let (events, end) = self.normalizer.frame(frame);
                for event in events {
                    // Between turns only session state and subagents still
                    // working in the background have anything to say.
                    let between = self.turns == 0;
                    if between && !matches!(event, AgentEvent::BackgroundTasks { .. } | AgentEvent::Subagent { .. }) {
                        continue;
                    }
                    self.emit(event).await?;
                }
                let Some(end) = end else {
                    return Ok(());
                };
                let status = match end.error {
                    // Stopping fails the turn; that's no error.
                    Some(_) if self.interrupt_deadline.is_some() => DoneStatus::Interrupted,
                    Some(message) => {
                        self.emit(AgentEvent::Error { message }).await?;
                        DoneStatus::Errored
                    }
                    None if self.interrupt_deadline.is_some() => DoneStatus::Interrupted,
                    None => DoneStatus::Completed,
                };
                self.end_turn(status).await
            }
        }
    }

    async fn on_control_request(&mut self, request: ControlRequestFrame) -> Result<(), Gone> {
        if request.request.subtype != "can_use_tool" {
            return Ok(());
        }
        let ControlRequestFrame {
            request_id,
            request: body,
        } = request;
        let reads_attachment = body.tool_name == "Read"
            && body
                .input
                .get("file_path")
                .and_then(Value::as_str)
                .is_some_and(|path| self.attachments.contains(path));
        let asked = if reads_attachment {
            None
        } else {
            approval::ask(&body, self.access, &self.allowed)
        };
        let Some((pending, request)) = asked else {
            self.write(wire::control_response_line(&request_id, wire::allow(body.input)));
            return Ok(());
        };
        self.pending.insert(request_id.clone(), pending);
        self.emit(AgentEvent::InputRequested { request_id, request }).await
    }

    async fn on_command(&mut self, command: RunCommand) -> Result<(), Gone> {
        match command {
            RunCommand::Send { prompt, attachments } => {
                if self.stdin.is_some() {
                    self.write_first().await;
                    if self.turns == 0 {
                        self.enter_plan();
                    }
                    self.turns += 1;
                    self.write_prompt(&prompt, attachments).await;
                }
                Ok(())
            }
            RunCommand::Answer { request_id, response } => {
                let Some(pending) = self.pending.remove(&request_id) else {
                    return Ok(());
                };
                let reply = self.answer(pending, &response);
                self.write(wire::control_response_line(&request_id, reply));
                self.emit(AgentEvent::InputResolved {
                    request_id,
                    response: Some(response),
                })
                .await
            }
            RunCommand::SetModes { access, plan } => {
                if (access, plan) != (self.access, self.plan) {
                    self.access = access;
                    self.plan = plan;
                    let id = self.control_id("outcode_mode");
                    self.write(wire::set_permission_mode_line(&id, permission_mode(access, plan)));
                }
                Ok(())
            }
            RunCommand::StopTask { task_id } => {
                let id = self.control_id("outcode_stop");
                self.write(wire::stop_task_line(&id, &task_id));
                Ok(())
            }
            RunCommand::Interrupt => {
                if self.turns == 0 || self.interrupt_deadline.is_some() {
                    return Ok(());
                }
                if self.first.take().is_some() {
                    // Never written: nothing to stop.
                    self.first_deadline = None;
                    return self.end_turn(DoneStatus::Interrupted).await;
                }
                self.interrupts_sent += 1;
                let id = format!("outcode_interrupt_{}", self.interrupts_sent);
                self.write(wire::interrupt_line(&id));
                // Whatever the turn waited on is refused, so it can stop.
                for (request_id, _) in self.pending.drain() {
                    let reply = wire::deny("The user stopped the turn.");
                    let _ = self.stdin.as_ref().map(|s| s.send(wire::control_response_line(&request_id, reply)));
                }
                self.interrupt_deadline = Some(Instant::now() + INTERRUPT_SETTLE);
                Ok(())
            }
            RunCommand::Close => {
                self.close_stdin();
                Ok(())
            }
        }
    }

    /// The control response the user's answer makes.
    fn answer(&mut self, pending: Pending, response: &InputResponse) -> Value {
        match (pending, response) {
            (Pending::Questions { input, questions }, InputResponse::Questions { answers }) => {
                wire::allow(input_with_answers(&input, &questions, answers))
            }
            (Pending::Approval { input, key, rules }, InputResponse::Approval { decision }) => match decision {
                ApprovalDecision::Allow => wire::allow(input),
                ApprovalDecision::AllowSession => {
                    self.allowed.insert(key);
                    match rules {
                        Some(rules) => wire::allow_with(input, rules),
                        None => wire::allow(input),
                    }
                }
                ApprovalDecision::Deny => wire::deny(approval::DENIED),
            },
            (Pending::Plan { input }, InputResponse::Plan { approve: true, .. }) => {
                // Implementing leaves plan mode for the access mode.
                self.plan = false;
                wire::exit_plan(input, access_permission_mode(self.access))
            }
            (Pending::Plan { .. }, InputResponse::Plan { feedback, .. }) => {
                let feedback = feedback.as_deref().map(str::trim).filter(|f| !f.is_empty());
                wire::deny(&match feedback {
                    Some(feedback) => format!("The user wants to keep planning. Their feedback: {feedback}"),
                    None => "The user wants to keep planning. Refine the plan before asking again.".into(),
                })
            }
            // An answer of the wrong kind allows nothing.
            _ => wire::deny(approval::DENIED),
        }
    }

    /// Reports the commands, split by the skills known now, when that
    /// changed what was last reported.
    async fn report_commands(&mut self) -> Result<(), Gone> {
        let listed = {
            let known = KNOWN_SKILLS.lock().unwrap();
            commands::classify(&self.advertised, known.as_ref())
        };
        if listed.is_empty() || listed == self.listed {
            return Ok(());
        }
        self.listed = listed.clone();
        self.emit(AgentEvent::AvailableCommands { commands: listed }).await
    }

    /// Writes the held first prompt, if it's still held.
    async fn write_first(&mut self) {
        self.first_deadline = None;
        if let Some((prompt, files)) = self.first.take() {
            self.write_prompt(&prompt, files).await;
        }
    }

    /// Writes a user turn: `$skill`s as Claude takes them, the attachments'
    /// paths listed under the prompt, and the images among them inline.
    async fn write_prompt(&mut self, prompt: &str, files: Vec<String>) {
        let skills = {
            let known = KNOWN_SKILLS.lock().unwrap();
            commands::skill_names(&self.advertised, known.as_ref())
        };
        let prompt = commands::skill_prompt(prompt, &skills);
        let images = attachments::load_images(&files).await;
        let text = attachments::prompt_with_attachments(&prompt, &files);
        self.attachments.extend(files);
        self.write(wire::user_line(&text, &images));
    }

    /// Puts the CLI back in plan mode for a turn about to start: approving
    /// the last plan left it in the access mode.
    fn enter_plan(&mut self) {
        if self.plan {
            let id = self.control_id("outcode_mode");
            self.write(wire::set_permission_mode_line(&id, "plan"));
        }
    }

    fn control_id(&mut self, prefix: &str) -> String {
        self.controls_sent += 1;
        format!("{prefix}_{}", self.controls_sent)
    }

    async fn end_turn(&mut self, status: DoneStatus) -> Result<(), Gone> {
        self.turns = self.turns.saturating_sub(1);
        self.interrupt_deadline = None;
        self.normalizer.end_turn();
        // Nothing can answer these any more; `Done` settles their parts.
        self.pending.clear();
        // A prompt written mid-turn starts next.
        if self.turns > 0 {
            self.enter_plan();
        }
        self.emit(AgentEvent::Done { status }).await
    }

    /// ⚠ Closing stdin ends the CLI, which then waits only 2s for a login
    /// refresh in flight: it closes once none is.
    fn close_stdin(&mut self) {
        if let Some(stdin) = self.stdin.take() {
            tokio::spawn(async move {
                refresh_lock::settle().await;
                drop(stdin);
            });
        }
    }

    /// The process exited. A turn still in flight ends here.
    async fn finish(mut self) {
        self.stdin = None;
        let status = wait_or_kill(&mut self.child).await;
        if self.normalizer.has_background() {
            let _ = self.events.send(AgentEvent::BackgroundTasks { tasks: Vec::new() }).await;
        }
        if self.turns == 0 {
            return;
        }
        let status = if self.interrupt_deadline.is_some() {
            DoneStatus::Interrupted
        } else {
            let message = self.stderr.under(format!(
                "Claude exited unexpectedly (exit code {}).",
                cli::exit_code(status)
            ));
            let _ = self.events.send(AgentEvent::Error { message }).await;
            DoneStatus::Errored
        };
        let _ = self.events.send(AgentEvent::Done { status }).await;
    }

    fn write(&self, line: String) {
        if let Some(stdin) = &self.stdin {
            let _ = stdin.send(line);
        }
    }

    async fn emit(&self, event: AgentEvent) -> Result<(), Gone> {
        self.events.send(event).await.map_err(|_| Gone)
    }
}

/// The tool input with `answers` added, keyed by question text: a string
/// for single-select, comma-joined labels for multi-select.
fn input_with_answers(input: &Value, questions: &[UserInputQuestion], answers: &[UserInputAnswer]) -> Value {
    let mut updated = input.as_object().cloned().unwrap_or_default();
    let by_question = questions
        .iter()
        .map(|q| {
            let labels = answers
                .iter()
                .find(|a| a.question_id == q.id)
                .map(|a| a.labels.join(", "))
                .unwrap_or_default();
            (q.question.clone(), Value::String(labels))
        })
        .collect();
    updated.insert("answers".into(), Value::Object(by_question));
    Value::Object(updated)
}

/// Waits (at most 40s) until no Claude process is refreshing the login:
/// ⚠ what stopping the app has to wait for.
pub async fn settle_refresh() {
    refresh_lock::settle().await;
}

/// Ends a session nobody listens to: stdin closes once no login refresh is
/// in flight, and the CLI gets its grace to exit. Its stdout is drained
/// until then.
fn retire<T: Send + 'static>(mut child: Child, stdin: T, mut stdout: impl AsyncRead + Unpin + Send + 'static) {
    tokio::spawn(async move {
        tokio::spawn(async move {
            let _ = tokio::io::copy(&mut stdout, &mut tokio::io::sink()).await;
        });
        refresh_lock::settle().await;
        drop(stdin);
        let _ = wait_or_kill(&mut child).await;
    });
}

/// Waits [`cli::EXIT_GRACE`] for `child` to exit, then kills its tree —
/// ⚠ never while a login refresh is in flight.
async fn wait_or_kill(child: &mut Child) -> Option<std::process::ExitStatus> {
    if let Ok(status) = tokio::time::timeout(cli::EXIT_GRACE, child.wait()).await {
        return status.ok();
    }
    refresh_lock::settle().await;
    if let Ok(Some(status)) = child.try_wait() {
        return Some(status);
    }
    cli::kill_tree(child).await;
    None
}

/// The inline `--mcp-config` JSON for an injected server. `timeout` (ms) is
/// how long one of its tool calls may run.
fn mcp_config_arg(mcp: &outcode_proto::McpServer) -> String {
    serde_json::json!({
        "mcpServers": {
            &mcp.name: {
                "command": mcp.command,
                "args": mcp.args,
                "env": mcp.env,
                "timeout": outcode_proto::McpServer::TOOL_TIMEOUT_SECS * 1000,
            }
        }
    })
    .to_string()
}
#[cfg(test)]
mod tests {
    use outcode_proto::UserInputOption;
    use serde_json::json;

    use super::*;

    #[test]
    fn launch_args_follow_the_config() {
        let mut request = RunRequest {
            resume: Some("s1".into()),
            ..RunRequest::default()
        };
        let args = launch_args(&request).join(" ");
        assert!(args.starts_with("--permission-prompt-tool stdio --permission-mode default --resume s1"));
        request.config.access = AccessMode::AutoAcceptEdits;
        assert!(launch_args(&request).join(" ").contains("--permission-mode acceptEdits"));
        request.config.plan = true;
        assert!(launch_args(&request).join(" ").contains("--permission-mode plan"));
    }

    #[test]
    fn answers_go_back_keyed_by_question() {
        let input = json!({ "questions": [{ "question": "Which one?" }, { "question": "Also?" }] });
        let option = |label: &str| UserInputOption {
            label: label.into(),
            description: None,
        };
        let questions = vec![
            UserInputQuestion {
                id: "q0".into(),
                header: "Fix".into(),
                question: "Which one?".into(),
                options: vec![option("A"), option("B")],
                multi_select: false,
            },
            UserInputQuestion {
                id: "q1".into(),
                header: "More".into(),
                question: "Also?".into(),
                options: vec![option("X"), option("Y")],
                multi_select: true,
            },
        ];
        let answers = vec![
            UserInputAnswer {
                question_id: "q0".into(),
                labels: vec!["B".into()],
            },
            UserInputAnswer {
                question_id: "q1".into(),
                labels: vec!["X".into(), "Y".into()],
            },
        ];
        let updated = input_with_answers(&input, &questions, &answers);
        assert_eq!(updated["answers"], json!({ "Which one?": "B", "Also?": "X, Y" }));
        assert!(updated["questions"].is_array());
    }
}
