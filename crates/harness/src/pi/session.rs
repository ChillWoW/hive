//! A Pi run: one `pi --mode rpc` process holding one session, JSONL
//! commands on stdin, responses and session events on stdout.
//!
//! Startup sets the chat's model and thinking level (`set_model` doesn't
//! touch Pi's saved defaults), then `get_state` (the session id, the model's
//! window) and `get_commands`; the first prompt waits for `get_state`'s
//! answer. A prompt is accepted by its response (`handled`: no run follows,
//! the turn is over) and runs until `agent_settled`. A run Pi starts on its
//! own between turns (an extension's) opens a reply as a
//! [`AgentEvent::BackgroundTurn`]. Extension dialogs become questions, Hive's
//! own approval dialog (see `extension.mjs`) an approval.

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex};

use hive_proto::{
    AgentEvent, DoneStatus, HarnessId, RunRequest, SlashCommand, UserInputAnswer,
    UserInputQuestion,
};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Child;
use tokio::sync::mpsc;

use super::normalize::{string, Normalizer};
use super::{commands, models};
use crate::cli::{self, sleep_until, StderrTail, INTERRUPT_SETTLE};
use crate::{approval, attachments, Gone, HarnessError, Run, RunCommand};

/// The title of the `confirm` dialog Hive's extension asks approvals with.
pub(super) const APPROVAL_TITLE: &str = "hive:approval";
const AGENT: &str = "Pi";

const STATE_ID: &str = "hive_state";
const COMMANDS_ID: &str = "hive_commands";
const MODEL_ID: &str = "hive_model";

pub(super) struct Launch {
    pub exe: PathBuf,
    pub request: RunRequest,
    /// A title run: no tools, no session, no extension; ends after its turn.
    pub title: bool,
    /// Hive's extension, loaded with `-e` (chat runs).
    pub extension: Option<PathBuf>,
    /// Each folder's commands, as runs there listed them.
    pub commands: Arc<Mutex<HashMap<String, Vec<SlashCommand>>>>,
}

pub(super) fn run(launch: Launch) -> Result<Run, HarnessError> {
    let Launch {
        exe,
        request,
        title,
        extension,
        commands: known_commands,
    } = launch;
    let mut cmd = crate::overrides::command(HarnessId::Pi, &exe);
    cmd.args(["--mode", "rpc"]);
    if title {
        cmd.args([
            "--no-session",
            "--no-tools",
            "--no-skills",
            "--no-prompt-templates",
            "--no-context-files",
            "--no-mcp",
            "--system-prompt",
            crate::TEXT_INSTRUCTIONS,
        ]);
    } else {
        if let Some(id) = &request.resume {
            cmd.args(["--session-id", id]);
        }
        if let Some(extension) = &extension {
            cmd.arg("-e").arg(extension);
        }
        let access = match approval::access(&request) {
            hive_proto::AccessMode::Supervised => "supervised",
            hive_proto::AccessMode::AutoAcceptEdits => "auto-accept-edits",
            hive_proto::AccessMode::FullAccess => "full-access",
        };
        cmd.env("HIVE_PI_ACCESS", access);
        if let Some(mcp) = &request.mcp {
            let config = json!({
                "name": mcp.name,
                "command": mcp.command,
                "args": mcp.args,
                "env": mcp.env,
                "timeoutMs": hive_proto::McpServer::TOOL_TIMEOUT_SECS * 1000,
            });
            cmd.env("HIVE_PI_MCP", config.to_string());
        }
        cmd.args(crate::overrides::get(HarnessId::Pi).args);
    }
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // The launcher (a `.cmd` shim, then node) starts the real process:
        // the whole tree is stopped at the end instead.
        .kill_on_drop(false);
    if !request.cwd.is_empty() {
        cmd.current_dir(&request.cwd);
    }
    #[cfg(unix)]
    cmd.process_group(0);
    let mut child = cmd.spawn().map_err(|e| HarnessError::Spawn("pi", e))?;
    let stdin = child.stdin.take().expect("piped stdin");
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = StderrTail::collect(child.stderr.take().expect("piped stderr"));

    let (stdin_tx, stdin_rx) = mpsc::unbounded_channel::<String>();
    tokio::spawn(cli::write_stdin(stdin, stdin_rx));
    if let Some((provider, id)) = request.model.as_deref().and_then(|m| m.split_once('/')) {
        let _ = stdin_tx.send(
            json!({"id": MODEL_ID, "type": "set_model", "provider": provider, "modelId": id}).to_string(),
        );
    }
    if let Some(level) = models::thinking_for(request.reasoning, &request.model_options) {
        let _ = stdin_tx.send(json!({"type": "set_thinking_level", "level": level}).to_string());
    }
    let _ = stdin_tx.send(json!({"id": STATE_ID, "type": "get_state"}).to_string());
    if !title {
        let _ = stdin_tx.send(json!({"id": COMMANDS_ID, "type": "get_commands"}).to_string());
    }

    let mut queue = VecDeque::new();
    queue.push_back((request.prompt.clone(), request.attachments.clone()));
    Ok(Run::spawn(256, move |events, commands| {
        Session {
            child,
            stdout: BufReader::new(stdout).lines(),
            stdin: Some(stdin_tx),
            commands,
            events,
            normalizer: Normalizer::default(),
            stderr,
            cwd: request.cwd.clone(),
            model: request.model.clone(),
            title,
            closing: false,
            ready: false,
            images: false,
            session_id: None,
            turn: None,
            queue,
            sent: 0,
            interrupt_deadline: None,
            pending: HashMap::new(),
            skills: Vec::new(),
            known_commands,
        }
        .run()
    }))
}

/// What the turn in flight waits on.
#[derive(Debug, Clone, PartialEq)]
enum Turn {
    /// A prompt's response, then (unless handled) `agent_settled`.
    Prompt { id: String, accepted: bool },
    /// `/compact`'s response.
    Compact { id: String },
    /// A run Pi started on its own: its `agent_settled`.
    Unprompted,
}

/// An extension dialog waiting on the user.
enum Pending {
    Confirm(UserInputQuestion),
    Select(Vec<String>),
    Text,
}

struct Session {
    child: Child,
    stdout: tokio::io::Lines<BufReader<tokio::process::ChildStdout>>,
    /// `None` once closed: Pi disposes its session and exits.
    stdin: Option<mpsc::UnboundedSender<String>>,
    commands: mpsc::UnboundedReceiver<RunCommand>,
    events: mpsc::Sender<AgentEvent>,
    normalizer: Normalizer,
    stderr: StderrTail,
    cwd: String,
    /// The model asked for, for a message when Pi lacks it.
    model: Option<String>,
    title: bool,
    /// Closed mid-turn: stdin closes once it ends.
    closing: bool,
    /// `get_state` answered: prompts may go.
    ready: bool,
    /// The model takes images.
    images: bool,
    session_id: Option<String>,
    turn: Option<Turn>,
    /// Prompts waiting for the turn in flight (or startup).
    queue: VecDeque<(String, Vec<String>)>,
    sent: u64,
    interrupt_deadline: Option<tokio::time::Instant>,
    pending: HashMap<String, Pending>,
    /// The folder's skills, for `$name`.
    skills: Vec<String>,
    known_commands: Arc<Mutex<HashMap<String, Vec<SlashCommand>>>>,
}

impl Session {
    async fn run(mut self) {
        let mut commands_open = true;
        loop {
            let outcome = tokio::select! {
                line = self.stdout.next_line() => match line {
                    Ok(Some(line)) => self.on_line(&line).await,
                    Ok(None) | Err(_) => break,
                },
                command = self.commands.recv(), if commands_open => match command {
                    Some(command) => self.on_command(command).await,
                    None => {
                        commands_open = false;
                        self.stdin = None;
                        Ok(())
                    }
                },
                _ = sleep_until(self.interrupt_deadline) => {
                    self.interrupt_deadline = None;
                    self.end_turn(DoneStatus::Interrupted, None).await
                }
            };
            if outcome.is_err() {
                // Nobody listens any more.
                self.stdin = None;
                cli::kill_tree(&mut self.child).await;
                return;
            }
        }
        self.finish().await;
    }

    async fn on_line(&mut self, line: &str) -> Result<(), Gone> {
        let Ok(frame) = serde_json::from_str::<Value>(line.trim()) else {
            return Ok(()); // Stray output.
        };
        match string(&frame, "type") {
            "response" => self.on_response(&frame).await,
            "extension_ui_request" => self.on_dialog(&frame).await,
            "agent_start" if self.turn.is_none() && self.ready && !self.title => {
                self.normalizer.start_turn();
                self.turn = Some(Turn::Unprompted);
                self.emit(AgentEvent::BackgroundTurn {
                    finished: Vec::new(),
                })
                .await
            }
            "agent_settled" => {
                let ends = matches!(
                    self.turn,
                    Some(Turn::Unprompted) | Some(Turn::Prompt { accepted: true, .. })
                );
                if ends {
                    let aborted = frame["aborted"].as_bool().unwrap_or(false)
                        || self.interrupt_deadline.is_some();
                    let (status, error) = self.normalizer.status(aborted);
                    self.end_turn(status, error).await?;
                }
                Ok(())
            }
            _ => {
                for event in self.normalizer.map(&frame) {
                    self.emit(event).await?;
                }
                Ok(())
            }
        }
    }

    async fn on_response(&mut self, frame: &Value) -> Result<(), Gone> {
        let id = string(frame, "id");
        let success = frame["success"].as_bool().unwrap_or(false);
        let error = frame["error"].as_str().unwrap_or("Pi refused the request.").to_owned();
        let data = &frame["data"];
        match id {
            STATE_ID => {
                self.ready = true;
                let model = &data["model"];
                self.session_id = data["sessionId"].as_str().map(str::to_owned);
                self.images = model["input"]
                    .as_array()
                    .is_some_and(|i| i.iter().any(|v| v == "image"));
                self.normalizer.window = model["contextWindow"].as_u64();
                if !self.title {
                    self.emit(AgentEvent::SessionStarted {
                        harness: HarnessId::Pi,
                        model: models::model_id(model).unwrap_or_default(),
                        cwd: self.cwd.clone(),
                        session_id: self.session_id.clone().unwrap_or_default(),
                        tools: Vec::new(),
                    })
                    .await?;
                    if self.normalizer.window.is_some() {
                        self.emit(AgentEvent::ContextUsage {
                            tokens: None,
                            window: self.normalizer.window,
                        })
                        .await?;
                    }
                }
                self.next_prompt().await
            }
            COMMANDS_ID if success => {
                let listed = commands::parse(data);
                self.skills = commands::skill_names(&listed);
                self.known_commands
                    .lock()
                    .unwrap()
                    .insert(self.cwd.clone(), listed.clone());
                self.emit(AgentEvent::AvailableCommands {
                    commands: commands::with_builtins(&listed),
                })
                .await
            }
            MODEL_ID if !success => {
                let model = self.model.clone().unwrap_or_default();
                self.emit(AgentEvent::Error {
                    message: format!("Pi couldn't switch to {model} ({error}); its default model answers instead."),
                })
                .await
            }
            _ => match self.turn.clone() {
                Some(Turn::Prompt { id: turn_id, .. }) if turn_id == id => {
                    if !success {
                        return self.end_turn(DoneStatus::Errored, Some(error)).await;
                    }
                    if data["disposition"] == "handled" {
                        return self.end_turn(DoneStatus::Completed, None).await;
                    }
                    self.turn = Some(Turn::Prompt {
                        id: turn_id,
                        accepted: true,
                    });
                    Ok(())
                }
                Some(Turn::Compact { id: turn_id }) if turn_id == id => {
                    let (result, error) = if success {
                        (Some(data), None)
                    } else {
                        (None, Some(error))
                    };
                    let stopped = self.interrupt_deadline.is_some();
                    let error = error.filter(|_| !stopped);
                    for event in self.normalizer.compaction_ended(result, error, false) {
                        self.emit(event).await?;
                    }
                    let status = if stopped {
                        DoneStatus::Interrupted
                    } else {
                        DoneStatus::Completed
                    };
                    self.end_turn(status, None).await
                }
                _ => Ok(()),
            },
        }
    }

    /// An extension's `ctx.ui` call: dialogs become questions, warnings and
    /// errors show; the rest is terminal chrome.
    async fn on_dialog(&mut self, frame: &Value) -> Result<(), Gone> {
        let id = string(frame, "id").to_owned();
        let title = string(frame, "title");
        let (question, pending) = match string(frame, "method") {
            "confirm" if title == APPROVAL_TITLE => {
                let call: Value = serde_json::from_str(string(frame, "message")).unwrap_or_default();
                let question = approval_question(string(&call, "tool"), &call["input"]);
                (question.clone(), Pending::Confirm(question))
            }
            "confirm" => {
                let question = approval::question(
                    AGENT,
                    join(title, string(frame, "message")),
                );
                (question.clone(), Pending::Confirm(question))
            }
            "select" => {
                let options: Vec<String> = frame["options"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|o| o.as_str().map(str::to_owned))
                    .collect();
                (
                    ask(title, options.clone()),
                    Pending::Select(options),
                )
            }
            "input" | "editor" => {
                let text = join(title, string(frame, "placeholder"));
                (ask(&text, Vec::new()), Pending::Text)
            }
            "notify" if matches!(string(frame, "notifyType"), "warning" | "error") => {
                return self
                    .emit(AgentEvent::Error {
                        message: string(frame, "message").to_owned(),
                    })
                    .await;
            }
            _ => return Ok(()),
        };
        if self.title {
            // Nobody to ask.
            self.write(json!({"type": "extension_ui_response", "id": id, "cancelled": true}));
            return Ok(());
        }
        self.pending.insert(id.clone(), pending);
        self.emit(AgentEvent::InputRequested {
            request_id: id,
            questions: vec![question],
        })
        .await
    }

    async fn on_command(&mut self, command: RunCommand) -> Result<(), Gone> {
        match command {
            RunCommand::Send {
                prompt,
                attachments,
            } => {
                if self.stdin.is_some() {
                    self.queue.push_back((prompt, attachments));
                    self.next_prompt().await?;
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
                self.write(dialog_answer(&request_id, &pending, &answers));
                self.emit(AgentEvent::InputResolved { request_id }).await
            }
            RunCommand::Interrupt => {
                if self.turn.is_some() && self.interrupt_deadline.is_none() {
                    self.cancel_dialogs().await?;
                    self.write(json!({"type": "abort"}));
                    self.interrupt_deadline = Some(tokio::time::Instant::now() + INTERRUPT_SETTLE);
                }
                Ok(())
            }
            RunCommand::StopTask { .. } => Ok(()),
            RunCommand::TaskOutput { reply, .. } => {
                let _ = reply.send(Err("Pi doesn't report background tasks.".into()));
                Ok(())
            }
            RunCommand::Close => {
                self.queue.clear();
                if self.turn.is_none() {
                    self.stdin = None;
                } else {
                    // After the turn.
                    self.closing = true;
                }
                Ok(())
            }
        }
    }

    /// Starts the next waiting prompt, once Pi is ready and idle.
    async fn next_prompt(&mut self) -> Result<(), Gone> {
        if !self.ready || self.turn.is_some() {
            return Ok(());
        }
        let Some((prompt, files)) = self.queue.pop_front() else {
            return Ok(());
        };
        self.normalizer.start_turn();
        self.sent += 1;
        let trimmed = prompt.trim();
        if let Some(rest) = trimmed.strip_prefix("/compact").filter(|r| r.is_empty() || r.starts_with(char::is_whitespace)) {
            let id = format!("hive_compact_{}", self.sent);
            self.turn = Some(Turn::Compact { id: id.clone() });
            let mut command = json!({"id": id, "type": "compact"});
            if !rest.trim().is_empty() {
                command["customInstructions"] = rest.trim().into();
            }
            self.write(command);
            if let Some(event) = self.normalizer.compaction_started(false) {
                self.emit(event).await?;
            }
            return Ok(());
        }
        let id = format!("hive_prompt_{}", self.sent);
        let message = attachments::prompt_with_attachments(
            &commands::skill_prompt(&prompt, &self.skills),
            &files,
        );
        let mut command = json!({"id": id, "type": "prompt", "message": message});
        if self.images {
            let images: Vec<Value> = attachments::load_images(&files)
                .await
                .into_iter()
                .map(|i| json!({"type": "image", "data": i.data, "mimeType": i.media_type}))
                .collect();
            if !images.is_empty() {
                command["images"] = images.into();
            }
        }
        self.turn = Some(Turn::Prompt {
            id,
            accepted: false,
        });
        self.write(command);
        Ok(())
    }

    async fn end_turn(&mut self, status: DoneStatus, error: Option<String>) -> Result<(), Gone> {
        if self.turn.take().is_none() {
            return Ok(());
        }
        self.interrupt_deadline = None;
        self.cancel_dialogs().await?;
        // A compaction the turn left running was cut short.
        for event in self.normalizer.compaction_ended(None, None, true) {
            self.emit(event).await?;
        }
        self.emit(AgentEvent::Done {
            status,
            error,
            session_id: self.session_id.clone(),
        })
        .await?;
        if self.title || self.closing {
            self.queue.clear();
            self.stdin = None;
        }
        self.next_prompt().await
    }

    /// Dialogs still open are dismissed: the turn they belong to is over.
    async fn cancel_dialogs(&mut self) -> Result<(), Gone> {
        let open: Vec<String> = self.pending.drain().map(|(id, _)| id).collect();
        for request_id in open {
            self.write(json!({"type": "extension_ui_response", "id": request_id, "cancelled": true}));
            self.emit(AgentEvent::InputResolved { request_id }).await?;
        }
        Ok(())
    }

    /// The process exited. A turn still in flight ends here.
    async fn finish(mut self) {
        self.stdin = None;
        let status = match tokio::time::timeout(cli::EXIT_GRACE, self.child.wait()).await {
            Ok(status) => status.ok(),
            Err(_) => {
                cli::kill_tree(&mut self.child).await;
                None
            }
        };
        if self.turn.is_none() {
            return;
        }
        let (status, error) = if self.interrupt_deadline.is_some() {
            (DoneStatus::Interrupted, None)
        } else {
            let code = cli::exit_code(status);
            let message = self
                .stderr
                .under(format!("pi exited unexpectedly (exit code {code})."));
            (DoneStatus::Errored, Some(message))
        };
        let _ = self
            .events
            .send(AgentEvent::Done {
                status,
                error,
                session_id: self.session_id.clone(),
            })
            .await;
    }

    fn write(&self, line: Value) {
        if let Some(stdin) = &self.stdin {
            let _ = stdin.send(line.to_string());
        }
    }

    async fn emit(&self, event: AgentEvent) -> Result<(), Gone> {
        crate::emit(&self.events, event).await
    }
}

/// "title — detail", either alone when the other is empty.
fn join(title: &str, detail: &str) -> String {
    match (title.trim(), detail.trim()) {
        (t, "") => t.to_owned(),
        ("", d) => d.to_owned(),
        (t, d) => format!("{t}\n\n{d}"),
    }
}

/// An extension's own question.
fn ask(question: &str, options: Vec<String>) -> UserInputQuestion {
    UserInputQuestion {
        id: "answer".into(),
        header: AGENT.into(),
        question: question.into(),
        options,
        multi_select: false,
    }
}

/// The approval a tool call the access mode doesn't cover asks.
fn approval_question(tool: &str, input: &Value) -> UserInputQuestion {
    match tool {
        "bash" | "powershell" => approval::command(AGENT, string(input, "command")),
        "edit" | "write" => {
            let path = string(input, "path");
            let paths: Vec<&str> = (!path.is_empty()).then_some(path).into_iter().collect();
            approval::edit(AGENT, &paths)
        }
        _ => {
            let name = match tool.strip_prefix("mcp__").and_then(|r| r.split_once("__")) {
                Some((server, tool)) => format!("{server}'s {tool}"),
                None => tool.to_owned(),
            };
            approval::tool(AGENT, &name, None)
        }
    }
}

/// The `extension_ui_response` for a dialog `answers` answer.
fn dialog_answer(id: &str, pending: &Pending, answers: &[UserInputAnswer]) -> Value {
    let labels: Vec<&str> = answers
        .iter()
        .flat_map(|a| a.labels.iter().map(String::as_str))
        .collect();
    match pending {
        Pending::Confirm(question) => {
            json!({"type": "extension_ui_response", "id": id, "confirmed": approval::approved(question, answers)})
        }
        Pending::Select(options) => match labels.iter().find(|l| options.iter().any(|o| o == *l)) {
            Some(value) => json!({"type": "extension_ui_response", "id": id, "value": value}),
            None => json!({"type": "extension_ui_response", "id": id, "cancelled": true}),
        },
        Pending::Text if !labels.is_empty() => {
            json!({"type": "extension_ui_response", "id": id, "value": labels.join("\n")})
        }
        Pending::Text => json!({"type": "extension_ui_response", "id": id, "cancelled": true}),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn answer(labels: &[&str], id: &str) -> Vec<UserInputAnswer> {
        vec![UserInputAnswer {
            question_id: id.into(),
            labels: labels.iter().map(|l| l.to_string()).collect(),
        }]
    }

    #[test]
    fn approvals_name_what_they_allow() {
        let q = approval_question("bash", &json!({"command": "rm -rf target"}));
        assert_eq!(q.question, "Pi wants to run `rm -rf target`. Allow it?");
        let q = approval_question("write", &json!({"path": "a.txt"}));
        assert_eq!(q.question, "Pi wants to modify a.txt. Allow it?");
        let q = approval_question("mcp__hive__whoami", &json!({}));
        assert!(q.question.contains("hive's whoami"));
    }

    #[test]
    fn dialogs_get_their_answers() {
        let confirm = Pending::Confirm(approval::question("Pi", "Go?"));
        assert_eq!(
            dialog_answer("d", &confirm, &answer(&["Yes"], "approval"))["confirmed"],
            true
        );
        assert_eq!(
            dialog_answer("d", &confirm, &answer(&["No"], "approval"))["confirmed"],
            false
        );
        let select = Pending::Select(vec!["A".into(), "B".into()]);
        assert_eq!(dialog_answer("d", &select, &answer(&["B"], "answer"))["value"], "B");
        assert_eq!(dialog_answer("d", &select, &answer(&["C"], "answer"))["cancelled"], true);
        assert_eq!(dialog_answer("d", &Pending::Text, &answer(&["hi"], "answer"))["value"], "hi");
    }
}
