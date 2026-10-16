//! Claude Code: spawns the installed `claude` CLI and speaks its stream-json
//! protocol over stdin/stdout.
//!
//! - The session opens with an `initialize` control request (its response
//!   lists the slash commands), then each turn is a user line on stdin. The
//!   process stays up between turns until stdin closes.
//! - Permission prompts ride the stdio control channel
//!   (`--permission-prompt-tool stdio`, undocumented but what the Agent SDK
//!   uses): the CLI sends `can_use_tool` and waits for allow/deny.
//!   `AskUserQuestion` and, unless `auto_approve` is set, every other prompt
//!   surface as [`AgentEvent::InputRequested`] keyed by the CLI's request id.
//! - Each turn ends with the CLI's own `result` frame.
//! - Interrupt sends the `interrupt` control request: the turn ends with an
//!   interrupted `result` and the process keeps running.

mod normalize;
mod wire;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use hive_proto::{
    AgentEvent, DoneStatus, HarnessId, ReasoningLevel, RunRequest, SandboxLevel, SlashCommand,
    ToolCall, UserInputAnswer, UserInputQuestion,
};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStderr, ChildStdin, Command};
use tokio::sync::mpsc;

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

#[derive(Default)]
pub struct ClaudeHarness {
    executable: Option<PathBuf>,
}

impl ClaudeHarness {
    pub fn new() -> Self {
        Self::default()
    }

    /// Uses `path` instead of looking `claude` up on PATH.
    pub fn with_executable(path: impl Into<PathBuf>) -> Self {
        Self {
            executable: Some(path.into()),
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
            "--permission-prompt-tool",
            "stdio",
            "--permission-mode",
            permission_mode(request.sandbox),
        ]
        .map(str::to_owned)
        .into();
        if let Some(model) = &request.model {
            args.extend(["--model".into(), model.clone()]);
        }
        if let Some(level) = request.reasoning {
            args.extend(["--effort".into(), effort(level).into()]);
        }
        if let Some(session) = &request.resume {
            args.extend(["--resume".into(), session.clone()]);
        }
        args
    }
}

fn permission_mode(sandbox: SandboxLevel) -> &'static str {
    match sandbox {
        SandboxLevel::ReadOnly => "plan",
        SandboxLevel::WorkspaceWrite => "acceptEdits",
        SandboxLevel::DangerFullAccess => "bypassPermissions",
    }
}

fn effort(level: ReasoningLevel) -> &'static str {
    match level {
        ReasoningLevel::Minimal | ReasoningLevel::Low => "low",
        ReasoningLevel::Medium => "medium",
        ReasoningLevel::High => "high",
        ReasoningLevel::XHigh => "xhigh",
        ReasoningLevel::Max => "max",
    }
}

impl Harness for ClaudeHarness {
    fn id(&self) -> HarnessId {
        HarnessId::ClaudeCode
    }

    fn run(&self, request: RunRequest) -> Result<Run, HarnessError> {
        let exe = match &self.executable {
            Some(path) => path.clone(),
            None => find_on_path("claude").ok_or(HarnessError::NotInstalled("claude"))?,
        };
        let mut cmd = command_for(&exe);
        cmd.args(Self::launch_args(&request))
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
        let _ = stdin_tx.send(wire::initialize_line(INITIALIZE_ID));
        let _ = stdin_tx.send(wire::user_line(&request.prompt));

        let (events_tx, events) = mpsc::channel(256);
        let (handle, commands) = RunHandle::new();
        tokio::spawn(
            Session {
                child,
                stdout: BufReader::new(stdout).lines(),
                stdin: Some(stdin_tx),
                commands,
                events: events_tx,
                auto_approve: request.auto_approve,
                normalizer: Normalizer::default(),
                pending: HashMap::new(),
                turns: 1,
                interrupt_deadline: None,
                interrupts_sent: 0,
                stderr_tail,
            }
            .run(),
        );
        Ok(Run { events, handle })
    }
}

/// A `can_use_tool` request waiting on the user.
enum Pending {
    Questions {
        input: Value,
        questions: Vec<UserInputQuestion>,
    },
    Permission {
        input: Value,
    },
}

struct Session {
    child: Child,
    stdout: tokio::io::Lines<BufReader<tokio::process::ChildStdout>>,
    /// `None` once closed: the CLI finishes its turn and exits.
    stdin: Option<mpsc::UnboundedSender<String>>,
    commands: mpsc::UnboundedReceiver<RunCommand>,
    events: mpsc::Sender<AgentEvent>,
    auto_approve: bool,
    normalizer: Normalizer,
    pending: HashMap<String, Pending>,
    /// Prompts written whose turn hasn't ended yet.
    turns: usize,
    interrupt_deadline: Option<tokio::time::Instant>,
    interrupts_sent: u64,
    stderr_tail: Arc<Mutex<String>>,
}

/// The consumer dropped the event stream; tear the session down.
struct Gone;

impl Session {
    async fn run(mut self) {
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
                    let commands = parse_commands(&response.response.response);
                    if !commands.is_empty() {
                        self.emit(AgentEvent::AvailableCommands { commands })
                            .await?;
                    }
                }
                Ok(())
            }
            // A result with no turn in flight is a turn the run already
            // reported (an interrupt that settled without it).
            Frame::Result(_) if self.turns == 0 => Ok(()),
            frame => {
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

        if self.auto_approve {
            self.write(wire::control_response_line(
                &request_id,
                wire::allow(body.input),
            ));
            return Ok(());
        }

        let question = permission_question(&body.tool_name, &body.input);
        self.pending.insert(
            request_id.clone(),
            Pending::Permission { input: body.input },
        );
        self.emit(AgentEvent::InputRequested {
            request_id,
            questions: vec![question],
        })
        .await
    }

    async fn on_command(&mut self, command: RunCommand) -> Result<(), Gone> {
        match command {
            RunCommand::Send(prompt) => {
                if self.stdin.is_some() {
                    self.turns += 1;
                    self.write(wire::user_line(&prompt));
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
                    Pending::Permission { input } => {
                        let allowed = answers
                            .first()
                            .and_then(|a| a.labels.first())
                            .is_some_and(|label| label == ALLOW);
                        if allowed {
                            wire::allow(input)
                        } else {
                            wire::deny("The user denied this tool use.")
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

const ALLOW: &str = "Allow";
const DENY: &str = "Deny";

/// A permission prompt, as a two-option question.
fn permission_question(tool: &str, input: &Value) -> UserInputQuestion {
    let detail = match normalize::decode_tool_use(tool, input) {
        ToolCall::Exec { command } => Some(command),
        ToolCall::ReadFile { path }
        | ToolCall::WriteFile { path, .. }
        | ToolCall::EditFile { path, .. } => Some(path),
        ToolCall::WebFetch { url, .. } => Some(url),
        _ => None,
    };
    UserInputQuestion {
        id: "permission".into(),
        header: "Permission".into(),
        question: match detail {
            Some(detail) => format!("Allow {tool}: {detail}"),
            None => format!("Allow {tool}?"),
        },
        options: vec![ALLOW.into(), DENY.into()],
        multi_select: false,
    }
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

/// The `initialize` response's slash commands.
fn parse_commands(response: &Value) -> Vec<SlashCommand> {
    response
        .get("commands")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .filter_map(|c| {
            let name = c.get("name").and_then(Value::as_str)?;
            Some(SlashCommand {
                name: name.trim_start_matches('/').into(),
                description: c
                    .get("description")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .into(),
                input_hint: c
                    .get("argumentHint")
                    .and_then(Value::as_str)
                    .filter(|h| !h.is_empty())
                    .map(Into::into),
            })
        })
        .collect()
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
    fn permission_question_names_the_tool_input() {
        let q = permission_question("Bash", &json!({"command": "rm -rf build"}));
        assert_eq!(q.question, "Allow Bash: rm -rf build");
        assert_eq!(q.options, vec![ALLOW, DENY]);
    }

    #[test]
    fn launch_args_follow_the_request() {
        let request: RunRequest = serde_json::from_value(json!({
            "harness": "claude-code", "prompt": "p", "cwd": ".", "sandbox": "read-only",
            "model": "opus", "reasoning": "xhigh", "resume": "s1",
        }))
        .unwrap();
        let args = ClaudeHarness::launch_args(&request).join(" ");
        assert!(args.contains("--permission-mode plan"));
        assert!(args.contains("--model opus"));
        assert!(args.contains("--effort xhigh"));
        assert!(args.contains("--resume s1"));
    }
}
