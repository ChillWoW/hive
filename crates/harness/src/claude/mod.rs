//! Claude Code: spawns the installed `claude` CLI and speaks its stream-json
//! protocol over stdin/stdout.
//!
//! - The session opens with an `initialize` control request (its response
//!   lists the slash commands, split into commands and skills by
//!   [`commands`]); the first prompt waits for it. Each turn is a user line
//!   on stdin, `$skill` rewritten to what Claude takes. The process stays up
//!   between turns until stdin closes.
//! - Permissions ride the stdio control channel (`--permission-prompt-tool
//!   stdio`, undocumented but what the Agent SDK uses): the CLI sends
//!   `can_use_tool` and blocks until it gets an answer. The run's access mode
//!   decides what's asked: full access allows every call, auto-accept edits
//!   allows the edit tools and asks before the rest, supervised asks before
//!   each — a yes/no [`AgentEvent::InputRequested`] keyed by the CLI's
//!   request id (see [`crate::approval`]). `AskUserQuestion` goes the same
//!   way with the agent's own questions. `auto_approve` skips even the CLI's
//!   own checks (`bypassPermissions`).
//! - Access and plan modes map onto `--permission-mode` ([`permission_mode`]).
//!   Plan mode ends when the user approves `ExitPlanMode`; the run continues
//!   in its access mode, and while the chat stays in plan mode each new turn
//!   switches the CLI back into it (`set_permission_mode`).
//! - Attachments: each turn lists its files' paths under the prompt
//!   ([`crate::attachments`]) and sends the images among them inline as
//!   base64 image blocks. Reading an attached file never asks.
//! - Each turn ends with the CLI's own `result` frame.
//! - Interrupt sends the `interrupt` control request: the turn ends with an
//!   interrupted `result` and the process keeps running.

mod commands;
mod normalize;
pub(crate) mod provider;
mod wire;

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use hive_proto::{
    AccessMode, AgentEvent, CommandKind, DoneStatus, HarnessCapabilities, HarnessCatalog,
    HarnessId, Model, ModelOption, ModelOptionChoice, ReasoningLevel, RunRequest, SlashCommand,
    UserInputAnswer, UserInputQuestion,
};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStderr, ChildStdin, Command};
use tokio::sync::mpsc;

use crate::approval::{self, Action};
use crate::attachments;
use crate::{Harness, HarnessError, Run, RunCommand, RunHandle};
use normalize::Normalizer;
use wire::{ControlRequestFrame, Frame};

const INITIALIZE_ID: &str = "hive_initialize";
/// How long an interrupted turn may take to report its `result` before the
/// run reports it interrupted anyway.
const INTERRUPT_SETTLE: Duration = Duration::from_secs(5);
/// How long the CLI gets to exit after stdin closes before it's killed.
const EXIT_GRACE: Duration = Duration::from_secs(3);
const STDERR_TAIL_BYTES: usize = 4096;
/// How long a command probe may take.
const PROBE_TIMEOUT: Duration = Duration::from_secs(20);
/// How long a probe's answer is reused for the same folder.
const PROBE_TTL: Duration = Duration::from_secs(30);
/// How long the first prompt waits on the `initialize` response.
const INITIALIZE_WAIT: Duration = Duration::from_secs(5);

/// The skills' names from the last `system:init` any run saw.
type KnownSkills = Arc<Mutex<Option<HashSet<String>>>>;

#[derive(Default)]
pub struct ClaudeHarness {
    executable: Option<PathBuf>,
    skills: KnownSkills,
    /// The last probe's command list per folder.
    probes: Arc<Mutex<HashMap<String, (std::time::Instant, Vec<commands::Advertised>)>>>,
}

impl ClaudeHarness {
    pub fn new() -> Self {
        Self::default()
    }

    /// Uses `path` instead of looking `claude` up on PATH.
    pub fn with_executable(path: impl Into<PathBuf>) -> Self {
        Self {
            executable: Some(path.into()),
            ..Self::default()
        }
    }

    fn launch_args(request: &RunRequest) -> Vec<String> {
        let mut args: Vec<String> = [
            "--print",
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
            // Required alongside `--print --output-format stream-json`.
            "--verbose",
            "--include-partial-messages",
            // Routes `can_use_tool` (and AskUserQuestion with it) to us.
            "--permission-prompt-tool",
            "stdio",
        ]
        .map(str::to_owned)
        .into();
        args.extend(["--permission-mode".into(), permission_mode(request).into()]);
        if request.auto_approve {
            // In plan mode the bypass is only made available (the skip flag
            // itself overrides `--permission-mode plan`), so approving the
            // plan can switch to it in place.
            args.push(if request.plan {
                "--allow-dangerously-skip-permissions".into()
            } else {
                "--dangerously-skip-permissions".into()
            });
        }
        if let Some(model) = &request.model {
            args.extend(["--model".into(), model.clone()]);
        }
        if let Some(level) = request.reasoning {
            args.extend(["--effort".into(), effort(level).into()]);
        }
        if let Some(session) = &request.resume {
            args.extend(["--resume".into(), session.clone()]);
        }
        if fast_mode(request) {
            args.extend(["--settings".into(), r#"{"fastMode":true}"#.into()]);
        }
        args
    }
}

/// What a run may do without asking. `auto_approve` means full access,
/// whatever the mode says.
fn access(request: &RunRequest) -> AccessMode {
    if request.auto_approve {
        AccessMode::FullAccess
    } else {
        request.access
    }
}

/// The CLI permission mode a run's access mode works in. Full access is
/// `bypassPermissions` only with `auto_approve`: without it the run stays in
/// `default` and every tool call is allowed when asked, so no run launches
/// with a skip-permissions flag it wasn't given (the CLI refuses those as
/// root outside a sandbox).
fn access_permission_mode(request: &RunRequest) -> &'static str {
    if request.auto_approve {
        return "bypassPermissions";
    }
    match request.access {
        AccessMode::AutoAcceptEdits => "acceptEdits",
        AccessMode::Supervised | AccessMode::FullAccess => "default",
    }
}

/// The `--permission-mode` a run launches (or a turn starts) with: plan mode
/// over its access mode.
fn permission_mode(request: &RunRequest) -> &'static str {
    if request.plan {
        "plan"
    } else {
        access_permission_mode(request)
    }
}

/// Claude's file-changing tools: auto-accept edits allows these unasked.
const EDIT_TOOLS: [&str; 4] = ["Edit", "Write", "MultiEdit", "NotebookEdit"];

/// What a `can_use_tool` request has to ask the user before it's allowed,
/// in `access`; `None` allows it now. `ExitPlanMode` (the plan is ready)
/// asks whether to start implementing it.
fn approval_question(
    tool: &str,
    display_name: Option<&str>,
    description: Option<&str>,
    input: &Value,
    access: AccessMode,
) -> Option<UserInputQuestion> {
    if tool == "ExitPlanMode" {
        return (!access.is_full_access()).then(|| {
            approval::question(
                "Approve plan",
                "Claude wants to start implementing its plan. Allow it?",
            )
        });
    }
    let edit = EDIT_TOOLS.contains(&tool);
    let action = if edit { Action::Edit } else { Action::Other };
    if approval::allowed_without_asking(access, action) {
        return None;
    }
    let field = |key: &str| input.get(key).and_then(Value::as_str);
    Some(if matches!(tool, "Bash" | "PowerShell") {
        approval::command("Claude", field("command").unwrap_or_default())
    } else if edit {
        let paths: Vec<&str> = field("file_path")
            .or_else(|| field("notebook_path"))
            .into_iter()
            .collect();
        approval::edit("Claude", &paths)
    } else {
        let name = display_name.filter(|n| !n.trim().is_empty()).unwrap_or(tool);
        approval::tool("Claude", name, description)
    })
}

/// What a refused approval tells the agent.
const APPROVAL_DENIED: &str = "The user did not allow this.";

fn effort(level: ReasoningLevel) -> &'static str {
    match level {
        ReasoningLevel::Minimal | ReasoningLevel::Low => "low",
        ReasoningLevel::Medium => "medium",
        ReasoningLevel::High => "high",
        ReasoningLevel::XHigh => "xhigh",
        ReasoningLevel::Max => "max",
    }
}

/// `--effort` levels; `effort` folds `Minimal` into `low`, so it isn't offered.
const EFFORTS: [ReasoningLevel; 5] = [
    ReasoningLevel::Low,
    ReasoningLevel::Medium,
    ReasoningLevel::High,
    ReasoningLevel::XHigh,
    ReasoningLevel::Max,
];

/// The model option for Claude's fast mode (its `fastMode` setting), offered
/// on Opus as in zeron.
const FAST_MODE: &str = "fastMode";

fn fast_mode_option() -> ModelOption {
    let choice = |id: &str, label: &str| ModelOptionChoice {
        id: id.into(),
        label: label.into(),
    };
    ModelOption {
        id: FAST_MODE.into(),
        label: "Fast mode".into(),
        choices: vec![choice("off", "Off"), choice("on", "On")],
        default_choice: "off".into(),
    }
}

/// On launches with `--settings {"fastMode":true}`; off leaves the user's
/// own setting alone.
fn fast_mode(request: &RunRequest) -> bool {
    request.model_options.get(FAST_MODE).map(String::as_str) == Some("on")
}

fn model(id: &str, label: &str, description: &str, reasoning: &[ReasoningLevel]) -> Model {
    Model {
        id: id.into(),
        label: label.into(),
        description: Some(description.into()),
        reasoning_levels: reasoning.to_vec(),
        options: Vec::new(),
    }
}

/// An Opus model: these take fast mode.
fn opus(id: &str, label: &str, description: &str) -> Model {
    Model {
        options: vec![fast_mode_option()],
        ..model(id, label, description, &EFFORTS)
    }
}

fn command(name: &str, description: &str) -> SlashCommand {
    SlashCommand {
        name: name.into(),
        description: description.into(),
        input_hint: None,
        kind: CommandKind::Command,
    }
}

impl Harness for ClaudeHarness {
    fn id(&self) -> HarnessId {
        HarnessId::ClaudeCode
    }

    /// Claude's models by their full ids, as zeron's curated catalog lists
    /// them: the current default first, then newest to oldest per family.
    fn catalog(&self) -> HarnessCatalog {
        HarnessCatalog {
            id: HarnessId::ClaudeCode,
            label: "Claude Code".into(),
            installed: self.executable.is_some() || find_claude().is_some(),
            models: vec![
                opus(
                    "claude-opus-5-5",
                    "Opus 5.5",
                    "Best for everyday, complex tasks",
                ),
                model(
                    "claude-fable-5-1",
                    "Fable 5.1",
                    "Most intelligent model for building agents",
                    &EFFORTS,
                ),
                model(
                    "claude-sonnet-5-5",
                    "Sonnet 5.5",
                    "Most efficient for simpler tasks",
                    &EFFORTS,
                ),
                model(
                    "claude-haiku-5-5",
                    "Haiku 5.5",
                    "Fastest for quick answers",
                    &EFFORTS,
                ),
                model("claude-fable-5", "Fable 5", "Previous generation Fable", &EFFORTS),
                opus("claude-opus-5", "Opus 5", "Previous generation Opus"),
                opus("claude-opus-4-8", "Opus 4.8", "Older generation Opus"),
                model(
                    "claude-sonnet-5",
                    "Sonnet 5",
                    "Previous generation Sonnet",
                    &EFFORTS,
                ),
                model(
                    "claude-haiku-4-5",
                    "Haiku 4.5",
                    "Previous generation Haiku",
                    &[],
                ),
            ],
            default_model: Some("claude-opus-5-5".into()),
            commands: vec![
                command("compact", "Summarize the conversation to free up context"),
                command("init", "Write a CLAUDE.md describing the codebase"),
                command("review", "Review a pull request"),
            ],
            access_modes: AccessMode::ALL.to_vec(),
            capabilities: HarnessCapabilities {
                // A prompt written mid-turn waits for the turn's `result`.
                steering: false,
                interrupt: true,
                // Images go inline; every file is listed by path for Read.
                attachments: true,
                // The CLI's own plan mode; approving `ExitPlanMode` ends it.
                plan: true,
            },
        }
    }

    fn run(&self, request: RunRequest) -> Result<Run, HarnessError> {
        self.spawn(request, false)
    }

    fn supports_titles(&self) -> bool {
        true
    }

    /// Starts the CLI in `cwd` for its `initialize` response alone — no
    /// prompt, so no model turn and no MCP servers — then stops it.
    fn commands(&self, cwd: &str) -> crate::CommandsFuture {
        let exe = self.executable.clone().or_else(find_claude);
        let skills = Arc::clone(&self.skills);
        let probes = Arc::clone(&self.probes);
        let cwd = cwd.to_owned();
        Box::pin(async move {
            let cached = probes
                .lock()
                .unwrap()
                .get(&cwd)
                .filter(|(at, _)| at.elapsed() < PROBE_TTL)
                .map(|(_, advertised)| advertised.clone());
            let advertised = match cached {
                Some(advertised) => advertised,
                None => {
                    let exe = exe.ok_or(HarnessError::NotInstalled("claude"))?;
                    let advertised = tokio::time::timeout(PROBE_TIMEOUT, probe(&exe, &cwd))
                        .await
                        .map_err(|_| HarnessError::Probe("claude didn't list its commands".into()))??;
                    probes
                        .lock()
                        .unwrap()
                        .insert(cwd, (std::time::Instant::now(), advertised.clone()));
                    advertised
                }
            };
            let known = skills.lock().unwrap();
            Ok(commands::classify(&advertised, known.as_ref()))
        })
    }

    /// The chat's modes don't apply: its tools are off, and anything it
    /// still asks for is a question the title run fails on.
    fn run_title(&self, mut request: RunRequest) -> Result<Run, HarnessError> {
        request.resume = None;
        request.attachments.clear();
        request.model_options.clear();
        request.auto_approve = false;
        request.access = AccessMode::Supervised;
        request.plan = false;
        self.spawn(request, true)
    }
}

impl ClaudeHarness {
    fn spawn(&self, request: RunRequest, title: bool) -> Result<Run, HarnessError> {
        let exe = match &self.executable {
            Some(path) => path.clone(),
            None => find_claude().ok_or(HarnessError::NotInstalled("claude"))?,
        };
        let mut cmd = command_for(&exe);
        cmd.args(Self::launch_args(&request));
        if title {
            cmd.args([
                "--system-prompt",
                crate::TITLE_INSTRUCTIONS,
                "--tools",
                "",
                "--mcp-config",
                r#"{"mcpServers":{}}"#,
                "--setting-sources",
                "",
            ]);
            if !managed_mcp_config() {
                cmd.arg("--strict-mcp-config");
            }
        }
        cmd
            // Set when Hive itself runs inside Claude Code; the child would
            // otherwise think it's nested.
            .env_remove("CLAUDECODE")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        if !request.cwd.is_empty() {
            cmd.current_dir(&request.cwd);
        }
        #[cfg(windows)]
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW

        let mut child = cmd.spawn().map_err(|e| HarnessError::Spawn("claude", e))?;
        let stdin = child.stdin.take().expect("piped stdin");
        let stdout = child.stdout.take().expect("piped stdout");
        let stderr = child.stderr.take().expect("piped stderr");

        let stderr_tail = Arc::new(Mutex::new(String::new()));
        tokio::spawn(collect_stderr(stderr, Arc::clone(&stderr_tail)));

        let (stdin_tx, stdin_rx) = mpsc::unbounded_channel::<String>();
        tokio::spawn(write_stdin(stdin, stdin_rx));
        // A title run needs no slash commands.
        if !title {
            let _ = stdin_tx.send(wire::initialize_line(INITIALIZE_ID));
        }
        // Written once the session task runs, after `initialize`: its images
        // are read from disk first.
        let first = (request.prompt.clone(), request.attachments.clone());

        let (events_tx, events) = mpsc::channel(256);
        let (handle, commands) = RunHandle::new();
        tokio::spawn(
            Session {
                child,
                stdout: BufReader::new(stdout).lines(),
                stdin: Some(stdin_tx),
                commands,
                events: events_tx,
                normalizer: Normalizer::default(),
                pending: HashMap::new(),
                access: access(&request),
                plan: request.plan,
                after_plan: access_permission_mode(&request),
                controls_sent: 0,
                turns: 1,
                interrupt_deadline: None,
                interrupts_sent: 0,
                attachments: HashSet::new(),
                stderr_tail,
                advertised: Vec::new(),
                listed: Vec::new(),
                known_skills: Arc::clone(&self.skills),
                first: None,
                first_deadline: (!title).then(|| tokio::time::Instant::now() + INITIALIZE_WAIT),
            }
            .run(first),
        );
        Ok(Run { events, handle })
    }
}

/// The CLI's command list, from an `initialize` sent to a CLI started
/// just for it.
async fn probe(exe: &Path, cwd: &str) -> Result<Vec<commands::Advertised>, HarnessError> {
    let mut cmd = command_for(exe);
    cmd.args([
        "--print",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--mcp-config",
        r#"{"mcpServers":{}}"#,
    ]);
    if !managed_mcp_config() {
        cmd.arg("--strict-mcp-config");
    }
    cmd.env_remove("CLAUDECODE")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    if !cwd.is_empty() {
        cmd.current_dir(cwd);
    }
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    let mut child = cmd.spawn().map_err(|e| HarnessError::Spawn("claude", e))?;
    // Kept open until the answer: closing stdin ends the CLI first.
    let mut stdin = child.stdin.take().expect("piped stdin");
    let mut line = wire::initialize_line(INITIALIZE_ID);
    line.push('\n');
    stdin
        .write_all(line.as_bytes())
        .await
        .map_err(|e| HarnessError::Spawn("claude", e))?;
    let mut lines = BufReader::new(child.stdout.take().expect("piped stdout")).lines();
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
    Err(HarnessError::Probe("claude exited before listing its commands".into()))
}

/// A `can_use_tool` request waiting on the user.
enum Pending {
    /// `AskUserQuestion`: the agent's own questions.
    Questions {
        input: Value,
        questions: Vec<UserInputQuestion>,
    },
    /// A tool call the access mode doesn't cover.
    Approval {
        input: Value,
        question: UserInputQuestion,
        exit_plan: bool,
    },
}

struct Session {
    child: Child,
    stdout: tokio::io::Lines<BufReader<tokio::process::ChildStdout>>,
    /// `None` once closed: the CLI finishes its turn and exits.
    stdin: Option<mpsc::UnboundedSender<String>>,
    commands: mpsc::UnboundedReceiver<RunCommand>,
    events: mpsc::Sender<AgentEvent>,
    normalizer: Normalizer,
    pending: HashMap<String, Pending>,
    /// What tool calls may do without asking.
    access: AccessMode,
    /// Each turn starts in plan mode.
    plan: bool,
    /// The permission mode approving a plan switches to.
    after_plan: &'static str,
    /// Our own control requests, for unique ids.
    controls_sent: u64,
    /// Prompts written whose turn hasn't ended yet.
    turns: usize,
    interrupt_deadline: Option<tokio::time::Instant>,
    interrupts_sent: u64,
    /// Paths of every file sent this session: reading one never asks.
    attachments: HashSet<String>,
    stderr_tail: Arc<Mutex<String>>,
    /// The CLI's command list, as last given.
    advertised: Vec<commands::Advertised>,
    /// The commands as last reported.
    listed: Vec<SlashCommand>,
    known_skills: KnownSkills,
    /// The first prompt, held until `initialize` answers: it needs the
    /// skills' names.
    first: Option<(String, Vec<String>)>,
    first_deadline: Option<tokio::time::Instant>,
}

/// The consumer dropped the event stream; tear the session down.
struct Gone;

impl Session {
    async fn run(mut self, (prompt, files): (String, Vec<String>)) {
        if self.first_deadline.is_some() {
            self.first = Some((prompt, files));
        } else {
            self.write_prompt(&prompt, files).await;
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
                        self.stdin = None;
                        Ok(())
                    }
                },
                _ = sleep_until(self.interrupt_deadline) => self.settle_interrupt().await,
                _ = sleep_until(self.first_deadline) => {
                    self.write_first().await;
                    Ok(())
                }
            };
            if outcome.is_err() {
                return; // `kill_on_drop` takes the process down.
            }
        }
        self.finish().await;
    }

    async fn on_line(&mut self, line: &str) -> Result<(), Gone> {
        let line = line.trim();
        if line.is_empty() {
            return Ok(());
        }
        let Ok(frame) = wire::parse_frame(line) else {
            return Ok(()); // Not JSON: stray CLI output.
        };
        match frame {
            Frame::ControlRequest(request) => self.on_control_request(request).await,
            Frame::ControlResponse(response) => {
                if response.response.request_id == INITIALIZE_ID {
                    if let Some(list) = response
                        .response
                        .response
                        .get("commands")
                        .and_then(Value::as_array)
                    {
                        self.advertised = commands::parse(list);
                    }
                    self.write_first().await;
                    self.report_commands().await?;
                }
                Ok(())
            }
            Frame::System(frame) if frame.subtype == "commands_changed" => {
                if let Some(list) = &frame.commands {
                    self.advertised = commands::parse(list);
                    self.report_commands().await?;
                }
                Ok(())
            }
            // A result with no turn in flight is a turn the run already
            // reported (an interrupt that settled without it).
            Frame::Result(_) if self.turns == 0 => Ok(()),
            frame => {
                if let Frame::System(f) = &frame {
                    if let (Some(skills), "init") = (&f.skills, f.subtype.as_str()) {
                        *self.known_skills.lock().unwrap() = Some(skills.iter().cloned().collect());
                        self.report_commands().await?;
                    }
                }
                let ends_turn = matches!(frame, Frame::Result(_));
                let interrupted = self.interrupt_deadline.is_some();
                for event in self.normalizer.normalize(frame, interrupted) {
                    self.emit(event).await?;
                }
                if ends_turn {
                    self.end_turn().await?;
                }
                Ok(())
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

        if body.tool_name == "AskUserQuestion" {
            let questions = parse_questions(&body.input);
            self.pending.insert(
                request_id.clone(),
                Pending::Questions {
                    input: body.input,
                    questions: questions.clone(),
                },
            );
            return self
                .emit(AgentEvent::InputRequested {
                    request_id,
                    questions,
                })
                .await;
        }

        let exit_plan = body.tool_name == "ExitPlanMode";
        let question = if self.reads_attachment(&body.tool_name, &body.input) {
            None
        } else {
            approval_question(
                &body.tool_name,
                body.display_name.as_deref(),
                body.description.as_deref(),
                &body.input,
                self.access,
            )
        };
        let Some(question) = question else {
            let response = self.allow(body.input, exit_plan);
            self.write(wire::control_response_line(&request_id, response));
            return Ok(());
        };
        self.pending.insert(
            request_id.clone(),
            Pending::Approval {
                input: body.input,
                question: question.clone(),
                exit_plan,
            },
        );
        self.emit(AgentEvent::InputRequested {
            request_id,
            questions: vec![question],
        })
        .await
    }

    /// Allows a tool call. Approving the plan leaves plan mode for the run's
    /// access mode, not the CLI's `default`.
    fn allow(&self, input: Value, exit_plan: bool) -> Value {
        if exit_plan {
            wire::exit_plan(input, self.after_plan)
        } else {
            wire::allow(input)
        }
    }

    /// Reports the commands, split by the skills known now, when that
    /// changed what was last reported.
    async fn report_commands(&mut self) -> Result<(), Gone> {
        let listed = {
            let known = self.known_skills.lock().unwrap();
            commands::classify(&self.advertised, known.as_ref())
        };
        if listed.is_empty() || listed == self.listed {
            return Ok(());
        }
        self.listed = listed.clone();
        self.emit(AgentEvent::AvailableCommands { commands: listed })
            .await
    }

    /// Writes the held first prompt, if it's still held.
    async fn write_first(&mut self) {
        self.first_deadline = None;
        if let Some((prompt, files)) = self.first.take() {
            self.write_prompt(&prompt, files).await;
        }
    }

    /// Writes a user turn: `$skill`s as Claude takes them, the attachments'
    /// paths listed under the prompt, and those that are images also sent
    /// inline.
    async fn write_prompt(&mut self, prompt: &str, files: Vec<String>) {
        let skills = {
            let known = self.known_skills.lock().unwrap();
            commands::skill_names(&self.advertised, known.as_ref())
        };
        let prompt = commands::skill_prompt(prompt, &skills);
        let images = attachments::load_images(&files).await;
        let text = attachments::prompt_with_attachments(&prompt, &files);
        self.attachments.extend(files);
        self.write(wire::user_line(&text, &images));
    }

    /// Reading a file the user attached needs no approval.
    fn reads_attachment(&self, tool: &str, input: &Value) -> bool {
        tool == "Read"
            && input
                .get("file_path")
                .and_then(Value::as_str)
                .is_some_and(|path| self.attachments.contains(path))
    }

    /// Puts the CLI back in plan mode for the turn about to start; approving
    /// the last plan left it in the access mode.
    fn enter_plan(&mut self) {
        if !self.plan {
            return;
        }
        self.controls_sent += 1;
        let id = format!("hive_mode_{}", self.controls_sent);
        self.write(wire::set_permission_mode_line(&id, "plan"));
    }

    async fn on_command(&mut self, command: RunCommand) -> Result<(), Gone> {
        match command {
            RunCommand::Send {
                prompt,
                attachments,
            } => {
                if self.stdin.is_some() {
                    self.write_first().await;
                    // A prompt sent mid-turn waits for it; `end_turn` puts
                    // plan mode back before that one starts.
                    if self.turns == 0 {
                        self.enter_plan();
                    }
                    self.turns += 1;
                    self.write_prompt(&prompt, attachments).await;
                }
                Ok(())
            }
            RunCommand::Answer {
                request_id,
                answers,
            } => {
                let Some(pending) = self.pending.remove(&request_id) else {
                    return Ok(());
                };
                let response = match pending {
                    Pending::Questions { input, questions } => {
                        wire::allow(input_with_answers(&input, &questions, &answers))
                    }
                    Pending::Approval {
                        input,
                        question,
                        exit_plan,
                    } => {
                        if approval::approved(&question, &answers) {
                            self.allow(input, exit_plan)
                        } else {
                            wire::deny(APPROVAL_DENIED)
                        }
                    }
                };
                self.write(wire::control_response_line(&request_id, response));
                self.emit(AgentEvent::InputResolved { request_id }).await
            }
            RunCommand::Interrupt => {
                if self.turns > 0 && self.interrupt_deadline.is_none() {
                    self.interrupts_sent += 1;
                    self.write(wire::interrupt_line(&format!(
                        "hive_interrupt_{}",
                        self.interrupts_sent
                    )));
                    self.interrupt_deadline = Some(tokio::time::Instant::now() + INTERRUPT_SETTLE);
                }
                Ok(())
            }
            RunCommand::Close => {
                self.stdin = None;
                Ok(())
            }
        }
    }

    /// The interrupted turn never reported; end it ourselves.
    async fn settle_interrupt(&mut self) -> Result<(), Gone> {
        self.emit(AgentEvent::Done {
            status: DoneStatus::Interrupted,
            error: None,
            session_id: self.normalizer.session_id.clone(),
        })
        .await?;
        self.end_turn().await
    }

    /// Questions the ended turn left open can no longer be answered.
    async fn end_turn(&mut self) -> Result<(), Gone> {
        self.turns = self.turns.saturating_sub(1);
        self.interrupt_deadline = None;
        // A queued prompt starts next.
        if self.turns > 0 {
            self.enter_plan();
        }
        let open: Vec<String> = self.pending.drain().map(|(id, _)| id).collect();
        for request_id in open {
            self.emit(AgentEvent::InputResolved { request_id }).await?;
        }
        Ok(())
    }

    /// The process exited. A turn still in flight ends here.
    async fn finish(mut self) {
        self.stdin = None;
        let status = match tokio::time::timeout(EXIT_GRACE, self.child.wait()).await {
            Ok(status) => status.ok(),
            Err(_) => {
                let _ = self.child.kill().await;
                None
            }
        };
        if self.turns == 0 {
            return;
        }
        let (status, error) = if self.interrupt_deadline.is_some() {
            (DoneStatus::Interrupted, None)
        } else {
            let stderr = self.stderr_tail.lock().unwrap().trim().to_owned();
            let code = status
                .and_then(|s| s.code())
                .map_or("unknown".to_owned(), |c| c.to_string());
            let mut message = format!("claude exited unexpectedly (exit code {code}).");
            if !stderr.is_empty() {
                message.push_str(&format!("\n{stderr}"));
            }
            (DoneStatus::Errored, Some(message))
        };
        let _ = self
            .events
            .send(AgentEvent::Done {
                status,
                error,
                session_id: self.normalizer.session_id.clone(),
            })
            .await;
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

async fn sleep_until(deadline: Option<tokio::time::Instant>) {
    match deadline {
        Some(at) => tokio::time::sleep_until(at).await,
        None => std::future::pending().await,
    }
}

/// Writes lines in order; dropping every sender closes stdin.
async fn write_stdin(mut stdin: ChildStdin, mut lines: mpsc::UnboundedReceiver<String>) {
    while let Some(mut line) = lines.recv().await {
        line.push('\n');
        if stdin.write_all(line.as_bytes()).await.is_err() || stdin.flush().await.is_err() {
            return;
        }
    }
}

/// Keeps the last few KB of stderr for crash messages.
async fn collect_stderr(mut stderr: ChildStderr, tail: Arc<Mutex<String>>) {
    let mut buf = [0u8; 1024];
    while let Ok(n) = stderr.read(&mut buf).await {
        if n == 0 {
            return;
        }
        let mut tail = tail.lock().unwrap();
        tail.push_str(&String::from_utf8_lossy(&buf[..n]));
        if tail.len() > STDERR_TAIL_BYTES {
            let mut cut = tail.len() - STDERR_TAIL_BYTES;
            while !tail.is_char_boundary(cut) {
                cut += 1;
            }
            tail.drain(..cut);
        }
    }
}

/// npm installs `claude.cmd`, which only runs through `cmd /C`.
fn command_for(exe: &Path) -> Command {
    let is_batch = exe
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("cmd") || e.eq_ignore_ascii_case("bat"));
    if is_batch {
        let mut cmd = Command::new("cmd");
        cmd.arg("/C").arg(exe);
        cmd
    } else {
        Command::new(exe)
    }
}

/// An administrator's `managed-mcp.json`, at the paths Claude Code reads.
/// While it exists the CLI refuses `--strict-mcp-config` and exits, and it
/// already keeps every other MCP server out on its own.
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

/// `claude` on PATH, else where its installers put it. An app started from
/// Finder or the Start menu may not see the shell's PATH, and one running
/// when the CLI was installed never sees the new entry.
pub(crate) fn find_claude() -> Option<PathBuf> {
    find_on_path("claude").or_else(|| install_locations().into_iter().find(|p| p.is_file()))
}

fn install_locations() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .map(PathBuf::from);
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
    paths
}

fn find_on_path(name: &str) -> Option<PathBuf> {
    let candidates: &[&str] = if cfg!(windows) {
        &["exe", "cmd", "bat"]
    } else {
        &[""]
    };
    std::env::split_paths(&std::env::var_os("PATH")?).find_map(|dir| {
        candidates.iter().find_map(|ext| {
            let path = dir.join(name).with_extension(ext);
            path.is_file().then_some(path)
        })
    })
}

/// `AskUserQuestion`'s input → questions. Option descriptions are dropped;
/// the wire type carries labels.
fn parse_questions(input: &Value) -> Vec<UserInputQuestion> {
    input
        .get("questions")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .enumerate()
        .map(|(i, q)| {
            let field = |key: &str| q.get(key).and_then(Value::as_str).unwrap_or("");
            UserInputQuestion {
                id: format!("q{i}"),
                header: match field("header") {
                    "" => "Question".into(),
                    header => header.into(),
                },
                question: field("question").into(),
                options: q
                    .get("options")
                    .and_then(Value::as_array)
                    .map(Vec::as_slice)
                    .unwrap_or_default()
                    .iter()
                    .filter_map(|o| match o {
                        Value::String(s) => Some(s.clone()),
                        other => other.get("label").and_then(Value::as_str).map(Into::into),
                    })
                    .collect(),
                multi_select: q
                    .get("multiSelect")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            }
        })
        .collect()
}

/// The tool input with `answers` added, keyed by question text: a string
/// for single-select, comma-joined labels for multi-select.
fn input_with_answers(
    input: &Value,
    questions: &[UserInputQuestion],
    answers: &[UserInputAnswer],
) -> Value {
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn ask_user_question_round_trips_answers() {
        let input = json!({"questions": [
            {"header": "Fix", "question": "Which one?", "options": [{"label": "A", "description": "first"}, "B"]},
            {"question": "Also?", "options": ["X", "Y"], "multiSelect": true}
        ]});
        let questions = parse_questions(&input);
        assert_eq!(questions[0].options, vec!["A", "B"]);
        assert_eq!(questions[1].header, "Question");
        assert!(questions[1].multi_select);

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
        assert_eq!(
            updated["answers"],
            json!({"Which one?": "B", "Also?": "X, Y"})
        );
        assert!(updated["questions"].is_array());
    }

    #[test]
    fn launch_args_follow_the_request() {
        let mut request: RunRequest = serde_json::from_value(json!({
            "harness": "claude-code", "prompt": "p", "cwd": ".", "sandbox": "read-only",
            "model": "opus", "reasoning": "xhigh", "resume": "s1",
        }))
        .unwrap();
        let args = ClaudeHarness::launch_args(&request).join(" ");
        // The sandbox level doesn't reach Claude; full access (the default)
        // allows tool calls over the control channel.
        assert!(args.contains("--permission-mode default"));
        assert!(args.contains("--model opus"));
        assert!(args.contains("--effort xhigh"));
        assert!(args.contains("--resume s1"));

        request.auto_approve = true;
        let args = ClaudeHarness::launch_args(&request).join(" ");
        assert!(args.contains("--permission-mode bypassPermissions"));
        assert!(args.contains("--dangerously-skip-permissions"));
        assert!(!args.contains("--settings"));

        request.model_options.insert("fastMode".into(), "on".into());
        let args = ClaudeHarness::launch_args(&request);
        let at = args.iter().position(|a| a == "--settings").unwrap();
        assert_eq!(args[at + 1], r#"{"fastMode":true}"#);
    }

    fn mode_request(access: AccessMode, auto_approve: bool, plan: bool) -> RunRequest {
        let mut request: RunRequest = serde_json::from_value(json!({
            "harness": "claude-code", "prompt": "p", "cwd": ".", "sandbox": "workspace-write",
        }))
        .unwrap();
        request.access = access;
        request.auto_approve = auto_approve;
        request.plan = plan;
        request
    }

    /// The flags after `--permission-prompt-tool stdio` that concern permissions.
    fn permission_args(request: &RunRequest) -> Vec<String> {
        let args = ClaudeHarness::launch_args(request);
        let at = args.iter().position(|a| a == "--permission-mode").unwrap();
        args[at..]
            .iter()
            .take_while(|a| !matches!(a.as_str(), "--model" | "--effort" | "--resume"))
            .cloned()
            .collect()
    }

    #[test]
    fn modes_launch_with_their_permission_mode() {
        use AccessMode::*;
        let cases: [(AccessMode, bool, bool, &[&str]); 7] = [
            (FullAccess, false, false, &["--permission-mode", "default"]),
            (
                AutoAcceptEdits,
                false,
                false,
                &["--permission-mode", "acceptEdits"],
            ),
            (Supervised, false, false, &["--permission-mode", "default"]),
            (
                Supervised,
                true,
                false,
                &[
                    "--permission-mode",
                    "bypassPermissions",
                    "--dangerously-skip-permissions",
                ],
            ),
            (FullAccess, false, true, &["--permission-mode", "plan"]),
            (AutoAcceptEdits, false, true, &["--permission-mode", "plan"]),
            (
                FullAccess,
                true,
                true,
                &[
                    "--permission-mode",
                    "plan",
                    "--allow-dangerously-skip-permissions",
                ],
            ),
        ];
        for (access, auto_approve, plan, expected) in cases {
            assert_eq!(
                permission_args(&mode_request(access, auto_approve, plan)),
                expected,
                "{access:?} auto_approve={auto_approve} plan={plan}"
            );
        }
        // Approving a plan lands in the access mode, not plan.
        assert_eq!(
            access_permission_mode(&mode_request(AutoAcceptEdits, false, true)),
            "acceptEdits"
        );
    }

    #[test]
    fn access_modes_decide_what_is_asked() {
        use AccessMode::*;
        let ask = |tool: &str, input: &Value, access| {
            approval_question(tool, None, None, input, access).map(|q| q.question)
        };
        for tool in ["Bash", "Edit", "WebFetch", "ExitPlanMode", "mcp__x__y"] {
            assert_eq!(ask(tool, &json!({}), FullAccess), None, "{tool}");
        }
        assert_eq!(
            ask("Edit", &json!({"file_path": "a.rs"}), AutoAcceptEdits),
            None
        );
        assert_eq!(
            ask("Bash", &json!({"command": "rm -rf build"}), AutoAcceptEdits).as_deref(),
            Some("Claude wants to run `rm -rf build`. Allow it?")
        );
        assert_eq!(
            ask("PowerShell", &json!({"command": "ls"}), Supervised).as_deref(),
            Some("Claude wants to run `ls`. Allow it?")
        );
        assert_eq!(
            ask("Write", &json!({"file_path": "a.rs"}), Supervised).as_deref(),
            Some("Claude wants to modify a.rs. Allow it?")
        );
        assert_eq!(
            ask("ExitPlanMode", &json!({"plan": "p"}), AutoAcceptEdits).as_deref(),
            Some("Claude wants to start implementing its plan. Allow it?")
        );
    }
}
