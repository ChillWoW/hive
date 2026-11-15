//! Claude Code: spawns the installed `claude` CLI and speaks its stream-json
//! protocol over stdin/stdout.
//!
//! - The session opens with an `initialize` control request; the first
//!   prompt waits for its answer (or [`INITIALIZE_WAIT`]). Each turn is a
//!   user line on stdin and ends with the CLI's `result` frame. The process
//!   stays up between turns until stdin closes.
//! - Interrupt sends the `interrupt` control request: the turn ends with an
//!   interrupted `result` and the process keeps running. One that doesn't
//!   report within [`INTERRUPT_SETTLE`] is ended by the run itself.
//! - ⚠ The process is never stopped while a login refresh is in flight
//!   ([`refresh_lock`]): stdin closes, and a kill happens, only once it has
//!   settled.

mod normalize;
mod refresh_lock;

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use outcode_proto::{AgentEvent, DoneStatus, RunRequest};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader, Lines};
use tokio::process::{Child, ChildStdout};
use tokio::sync::mpsc;
use tokio::time::Instant;

use crate::cli::{self, StderrTail, sleep_until};
use crate::{Gone, HarnessError, Run, RunCommand, RunHandle};
use normalize::Normalizer;

const NAME: &str = "claude";
const INITIALIZE_ID: &str = "outcode_initialize";
/// How long the first prompt waits on the `initialize` response.
const INITIALIZE_WAIT: Duration = Duration::from_secs(5);
/// How long an interrupted turn may take to report its end before the run
/// reports it interrupted anyway.
const INTERRUPT_SETTLE: Duration = Duration::from_secs(5);

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

/// Without an approval UI yet, tool calls that would ask are refused by the
/// CLI itself (`--print` has no one to ask).
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

/// Starts a `claude` session (`binary`, or the one [`find`] finds) with
/// `request.prompt` as its first turn. Must be called from inside a tokio
/// runtime.
pub fn run(request: RunRequest, binary: Option<&Path>) -> Result<Run, HarnessError> {
    let exe = find(binary)?;
    let mut cmd = cli::command(&exe);
    cmd.args(ARGS)
        // Set when Outcode itself runs inside Claude Code; the child would
        // otherwise think it's nested.
        .env_remove("CLAUDECODE")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let cwd = match request.cwd.trim() {
        "" => cli::home_dir(),
        cwd => Some(PathBuf::from(cwd)),
    };
    if let Some(cwd) = cwd {
        cmd.current_dir(cwd);
    }
    let mut child = cmd.spawn().map_err(|e| HarnessError::Spawn(NAME, e))?;
    let stdin = child.stdin.take().expect("piped stdin");
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = StderrTail::collect(child.stderr.take().expect("piped stderr"));

    let (stdin_tx, stdin_rx) = mpsc::unbounded_channel::<String>();
    tokio::spawn(cli::write_stdin(stdin, stdin_rx));
    let _ = stdin_tx.send(control_request_line(INITIALIZE_ID, json!({ "subtype": "initialize" })));

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
        interrupt_deadline: None,
        first: Some(request.prompt),
        first_deadline: Some(Instant::now() + INITIALIZE_WAIT),
    };
    tokio::spawn(session.run());
    Ok(Run { events, handle })
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
    /// Set while an interrupt waits for its turn to end.
    interrupt_deadline: Option<Instant>,
    /// The first prompt, held until `initialize` answers.
    first: Option<String>,
    first_deadline: Option<Instant>,
}

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
                        self.close_stdin();
                        Ok(())
                    }
                },
                _ = sleep_until(self.interrupt_deadline) => self.settle_interrupt().await,
                _ = sleep_until(self.first_deadline) => {
                    self.write_first();
                    Ok(())
                }
            };
            if outcome.is_err() {
                // Nobody listens any more.
                let Session {
                    child,
                    stdin,
                    stdout,
                    ..
                } = self;
                retire(child, stdin, stdout.into_inner());
                return;
            }
        }
        self.finish().await;
    }

    async fn on_line(&mut self, line: &str) -> Result<(), Gone> {
        let Ok(frame) = serde_json::from_str::<Value>(line.trim()) else {
            return Ok(()); // Not JSON: stray CLI output.
        };
        if frame["type"] == "control_response" {
            if frame.pointer("/response/request_id").and_then(Value::as_str) == Some(INITIALIZE_ID) {
                self.write_first();
            }
            return Ok(());
        }
        // Nothing in flight: what's left of a turn already reported ended
        // (an interrupt that settled without it).
        if self.turns == 0 {
            return Ok(());
        }
        let (events, end) = self.normalizer.frame(&frame);
        for event in events {
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
            None => DoneStatus::Completed,
        };
        self.end_turn(status).await
    }

    async fn on_command(&mut self, command: RunCommand) -> Result<(), Gone> {
        match command {
            RunCommand::Send { prompt } => {
                if self.stdin.is_some() {
                    self.write_first();
                    self.turns += 1;
                    self.write(user_line(&prompt));
                }
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
                self.write(control_request_line(&id, json!({ "subtype": "interrupt" })));
                self.interrupt_deadline = Some(Instant::now() + INTERRUPT_SETTLE);
                Ok(())
            }
            RunCommand::Close => {
                self.close_stdin();
                Ok(())
            }
        }
    }

    /// Writes the held first prompt, if it's still held.
    fn write_first(&mut self) {
        self.first_deadline = None;
        if let Some(prompt) = self.first.take() {
            self.write(user_line(&prompt));
        }
    }

    /// The interrupted turn never reported; end it ourselves.
    async fn settle_interrupt(&mut self) -> Result<(), Gone> {
        self.end_turn(DoneStatus::Interrupted).await
    }

    async fn end_turn(&mut self, status: DoneStatus) -> Result<(), Gone> {
        self.turns = self.turns.saturating_sub(1);
        self.interrupt_deadline = None;
        self.normalizer = Normalizer::default();
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

/// Waits (at most 40s) until no Claude process is refreshing the login:
/// ⚠ what stopping the app has to wait for.
pub async fn settle_refresh() {
    refresh_lock::settle().await;
}

/// Ends a session nobody listens to: stdin closes once no login refresh is
/// in flight, and the CLI gets its grace to exit. Its stdout is drained
/// until then.
fn retire<T: Send + 'static>(
    mut child: Child,
    stdin: T,
    mut stdout: impl AsyncRead + Unpin + Send + 'static,
) {
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

/// A user turn on stdin.
fn user_line(text: &str) -> String {
    json!({
        "type": "user",
        "message": { "role": "user", "content": text },
        "parent_tool_use_id": null,
    })
    .to_string()
}

fn control_request_line(request_id: &str, request: Value) -> String {
    json!({ "type": "control_request", "request_id": request_id, "request": request }).to_string()
}

