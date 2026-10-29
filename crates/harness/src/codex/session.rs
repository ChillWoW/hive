//! One run: a `codex app-server` holding one thread, a turn at a time.

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use hive_proto::{
    AccessMode, AgentEvent, DoneStatus, HarnessId, McpServer, RunRequest, SandboxLevel, UserInputAnswer,
    UserInputQuestion,
};
use serde_json::{json, Map, Value};
use tokio::process::Child;
use tokio::sync::mpsc;

use super::models::{self, FAST_MODE, SERVICE_TIER};
use super::normalize::Normalizer;
use super::rpc::{Client, Incoming, Server};
use super::skills::{self, Skill};
use crate::approval::{self, Action};
use crate::attachments;
use crate::claude::sleep_until;
use crate::{RunCommand, RunHandle};

/// How long an interrupted turn may take to report its end before the run
/// reports it interrupted anyway.
const INTERRUPT_SETTLE: Duration = Duration::from_secs(5);
/// How long the server gets to exit after stdin closes before it's killed.
const EXIT_GRACE: Duration = Duration::from_secs(3);
/// The turn that follows an approved plan.
const IMPLEMENT_PROMPT: &str = "Implement the plan.";

/// What the session was started for.
pub(super) struct Launch {
    pub exe: PathBuf,
    pub request: RunRequest,
    /// A title run: ephemeral thread, title instructions, nothing asked.
    pub title: bool,
    /// Skills known from earlier runs, by folder, refreshed here.
    pub skills: Arc<Mutex<HashMap<String, Vec<Skill>>>>,
}

pub(super) fn start(
    launch: Launch,
    events: mpsc::Sender<AgentEvent>,
    commands: mpsc::UnboundedReceiver<RunCommand>,
) {
    tokio::spawn(async move {
        let failed = |message: String| AgentEvent::Done {
            status: DoneStatus::Errored,
            error: Some(message),
            session_id: launch.request.resume.clone(),
        };
        let server = match Server::start(&launch.exe, &launch.request.cwd).await {
            Ok(server) => server,
            Err(e) => {
                let _ = events.send(failed(e.to_string())).await;
                return;
            }
        };
        match Session::open(server, &launch, events.clone()).await {
            Ok(session) => {
                session
                    .run(
                        launch.request.prompt.clone(),
                        launch.request.attachments.clone(),
                        commands,
                    )
                    .await
            }
            Err(message) => {
                let _ = events.send(failed(message)).await;
            }
        }
    });
}

/// Pairs `start` with a fresh handle.
pub(super) fn run(launch: Launch) -> crate::Run {
    let (events_tx, events) = mpsc::channel(256);
    let (handle, commands) = RunHandle::new();
    start(launch, events_tx, commands);
    crate::Run { events, handle }
}

struct Prompt {
    text: String,
    files: Vec<String>,
}

/// The turn in flight, from our `turn/start` until its end is reported.
struct Turn {
    /// Known once the server answers.
    id: Option<String>,
    /// Plan mode: a plan it ends with is offered for implementing.
    plan: bool,
    /// Asked to stop before its id was known.
    interrupt_pending: bool,
    /// Waiting on whether to implement its plan; no turn runs meanwhile.
    awaiting_plan: bool,
}

/// A server request (or our own plan question) waiting on the user, keyed by
/// the request id the UI answers.
enum Pending {
    Approval {
        rpc_id: Value,
        question: UserInputQuestion,
        kind: ApprovalKind,
    },
    Questions {
        rpc_id: Value,
        questions: Vec<UserInputQuestion>,
    },
    Plan {
        question: UserInputQuestion,
    },
}

enum ApprovalKind {
    /// Commands and file changes: `{ decision }`.
    Decision,
    /// `{ permissions, scope }`, granting what was asked.
    Permissions(Value),
    /// An MCP elicitation: `{ action, content }`.
    Elicitation,
}

/// Answers to our own requests, fed back into the loop.
enum Reply {
    TurnStarted(Result<Value, String>),
    Skills(Vec<Skill>),
}

struct Session {
    client: Client,
    child: Child,
    incoming: mpsc::Receiver<Incoming>,
    stderr_tail: Arc<Mutex<String>>,
    events: mpsc::Sender<AgentEvent>,
    normalizer: Normalizer,
    thread_id: String,
    model: String,
    cwd: String,
    /// The folder as requested: the skills cache's key.
    folder: String,
    access: AccessMode,
    plan: bool,
    effort: Option<&'static str>,
    service_tier: Option<String>,
    title: bool,
    skills: Vec<Skill>,
    skills_cache: Arc<Mutex<HashMap<String, Vec<Skill>>>>,
    /// Told after the first turn's `SessionStarted`: the old thread couldn't
    /// be resumed.
    resume_note: Option<String>,
    turn: Option<Turn>,
    queue: VecDeque<Prompt>,
    pending: HashMap<String, Pending>,
    /// Turns that ended here before the server said so (an interrupt that
    /// didn't settle); their late `turn/completed` is dropped.
    settled: Vec<String>,
    interrupt_deadline: Option<tokio::time::Instant>,
    replies: mpsc::UnboundedSender<Reply>,
    replies_rx: mpsc::UnboundedReceiver<Reply>,
    closing: bool,
    plans: u64,
}

/// The consumer dropped the event stream.
struct Gone;

/// What a run may do without asking. `auto_approve` means full access.
fn access(request: &RunRequest) -> AccessMode {
    if request.auto_approve {
        AccessMode::FullAccess
    } else {
        request.access
    }
}

/// The thread's approval policy: a run in full access is never asked;
/// otherwise every command that isn't known safe is, and the access mode
/// decides here which of those reach the user.
fn approval_policy(request: &RunRequest, title: bool) -> &'static str {
    if title || access(request).is_full_access() {
        "never"
    } else {
        "untrusted"
    }
}

fn sandbox_mode(request: &RunRequest, title: bool) -> &'static str {
    if title {
        return "read-only";
    }
    if request.auto_approve {
        return "danger-full-access";
    }
    match request.sandbox {
        SandboxLevel::ReadOnly => "read-only",
        SandboxLevel::WorkspaceWrite => "workspace-write",
        SandboxLevel::DangerFullAccess => "danger-full-access",
    }
}

/// The service tier a run's model options pick, if any.
pub(super) fn service_tier(request: &RunRequest) -> Option<String> {
    if request.model_options.get(FAST_MODE).map(String::as_str) == Some("on") {
        return Some("fast".into());
    }
    request
        .model_options
        .get(SERVICE_TIER)
        .filter(|tier| tier.as_str() != "default")
        .cloned()
}

/// `thread/start` (or `thread/resume`) parameters for a run.
pub(super) fn thread_params(request: &RunRequest, title: bool) -> Map<String, Value> {
    let mut params = Map::new();
    if !request.cwd.is_empty() {
        params.insert("cwd".into(), json!(request.cwd));
    }
    if let Some(model) = &request.model {
        params.insert("model".into(), json!(model));
    }
    params.insert(
        "approvalPolicy".into(),
        json!(approval_policy(request, title)),
    );
    params.insert("sandbox".into(), json!(sandbox_mode(request, title)));
    if let Some(tier) = service_tier(request) {
        params.insert("serviceTier".into(), json!(tier));
    }
    if title {
        params.insert("baseInstructions".into(), json!(crate::TITLE_INSTRUCTIONS));
        params.insert("ephemeral".into(), json!(true));
    } else if let Some(mcp) = &request.mcp {
        params.insert("config".into(), Value::Object(mcp_overrides(mcp)));
    }
    params
}

/// Dotted config overrides that add an injected MCP server on top of the
/// user's `mcp_servers` table.
fn mcp_overrides(mcp: &McpServer) -> Map<String, Value> {
    let key = |field: &str| format!("mcp_servers.{}.{field}", mcp.name);
    let mut config = Map::new();
    config.insert(key("command"), json!(mcp.command));
    config.insert(key("args"), json!(mcp.args));
    config.insert(key("env"), json!(mcp.env));
    // Hive's own tools: approved in every access mode, so Codex neither
    // rejects a call under `never` nor asks about one under the others.
    config.insert(key("default_tools_approval_mode"), json!("approve"));
    // Its calls may wait on the user (Codex cuts them off after 60s).
    config.insert(key("tool_timeout_sec"), json!(McpServer::TOOL_TIMEOUT_SECS));
    config
}

impl Session {
    async fn open(
        server: Server,
        launch: &Launch,
        events: mpsc::Sender<AgentEvent>,
    ) -> Result<Self, String> {
        let request = &launch.request;
        let Server {
            child,
            client,
            incoming,
            stderr_tail,
        } = server;
        let params = thread_params(request, launch.title);
        let mut resume_note = None;
        let opened = match &request.resume {
            Some(thread) if !launch.title => {
                let mut resume = params.clone();
                resume.insert("threadId".into(), json!(thread));
                match client.request("thread/resume", Value::Object(resume)).await {
                    Ok(result) => Ok(result),
                    Err(e) => {
                        resume_note = Some(format!(
                            "Couldn't resume the earlier Codex session ({e}); this continues in a new one."
                        ));
                        client.request("thread/start", Value::Object(params)).await
                    }
                }
            }
            _ => client.request("thread/start", Value::Object(params)).await,
        };
        let opened = opened.map_err(|e| {
            let stderr = stderr_tail.lock().unwrap().trim().to_owned();
            if stderr.is_empty() {
                format!("Codex couldn't start a session: {e}")
            } else {
                format!("Codex couldn't start a session: {e}\n{stderr}")
            }
        })?;
        let thread_id = opened["thread"]["id"]
            .as_str()
            .unwrap_or_default()
            .to_owned();
        let model = opened["model"]
            .as_str()
            .map(str::to_owned)
            .or_else(|| request.model.clone())
            .unwrap_or_default();
        let cwd = opened["cwd"]
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| request.cwd.clone());

        let (replies, replies_rx) = mpsc::unbounded_channel();
        let skills = launch
            .skills
            .lock()
            .unwrap()
            .get(&request.cwd)
            .cloned()
            .unwrap_or_default();
        if !launch.title {
            let list = client.request("skills/list", json!({ "cwds": [request.cwd] }));
            let replies = replies.clone();
            tokio::spawn(async move {
                if let Ok(result) = list.await {
                    let _ = replies.send(Reply::Skills(skills::parse(&result)));
                }
            });
        }
        let normalizer = Normalizer::new(thread_id.clone());
        Ok(Self {
            client,
            child,
            incoming,
            stderr_tail,
            events,
            normalizer,
            thread_id,
            model,
            cwd,
            folder: request.cwd.clone(),
            access: if launch.title {
                AccessMode::Supervised
            } else {
                access(request)
            },
            plan: request.plan && !launch.title,
            effort: request.reasoning.map(models::effort),
            service_tier: service_tier(request),
            title: launch.title,
            skills,
            skills_cache: Arc::clone(&launch.skills),
            resume_note,
            turn: None,
            queue: VecDeque::new(),
            pending: HashMap::new(),
            settled: Vec::new(),
            interrupt_deadline: None,
            replies,
            replies_rx,
            closing: false,
            plans: 0,
        })
    }

    async fn run(
        mut self,
        prompt: String,
        files: Vec<String>,
        mut commands: mpsc::UnboundedReceiver<RunCommand>,
    ) {
        if !self.skills.is_empty() {
            let _ = self.report_commands().await;
        }
        if self
            .begin(
                Prompt {
                    text: prompt,
                    files,
                },
                true,
            )
            .await
            .is_err()
        {
            return;
        }
        let mut commands_open = true;
        loop {
            let outcome = tokio::select! {
                message = self.incoming.recv() => match message {
                    Some(Incoming::Notification { method, params }) => self.on_notification(&method, &params).await,
                    Some(Incoming::Request { id, method, params }) => self.on_request(id, &method, &params).await,
                    None => break, // The server exited.
                },
                command = commands.recv(), if commands_open => match command {
                    Some(command) => self.on_command(command).await,
                    None => {
                        commands_open = false;
                        self.closing = true;
                        Ok(())
                    }
                },
                Some(reply) = self.replies_rx.recv() => self.on_reply(reply).await,
                _ = sleep_until(self.interrupt_deadline) => self.settle_interrupt().await,
            };
            if outcome.is_err() {
                return; // `kill_on_drop` takes the server down.
            }
            if self.closing && self.turn.is_none() {
                break;
            }
        }
        self.finish().await;
    }

    /// Starts a turn: the user's (`user`), or the one implementing an
    /// approved plan.
    async fn begin(&mut self, prompt: Prompt, user: bool) -> Result<(), Gone> {
        if user {
            self.emit(AgentEvent::SessionStarted {
                harness: HarnessId::Codex,
                model: self.model.clone(),
                cwd: self.cwd.clone(),
                session_id: self.thread_id.clone(),
                tools: Vec::new(),
            })
            .await?;
            if let Some(note) = self.resume_note.take() {
                self.emit(AgentEvent::Error { message: note }).await?;
            }
        }
        self.normalizer.start_turn();
        let plan = self.plan && user;
        self.turn = Some(Turn {
            id: None,
            plan,
            interrupt_pending: false,
            awaiting_plan: false,
        });
        let text = prompt.text.trim();
        let request = if prompt.files.is_empty() && text == "/compact" {
            self.client.request(
                "thread/compact/start",
                json!({ "threadId": self.thread_id }),
            )
        } else if prompt.files.is_empty() && (text == "/review" || text.starts_with("/review ")) {
            let instructions = text["/review".len()..].trim();
            let target = if instructions.is_empty() {
                json!({ "type": "uncommittedChanges" })
            } else {
                json!({ "type": "custom", "instructions": instructions })
            };
            self.client.request(
                "review/start",
                json!({ "threadId": self.thread_id, "target": target, "delivery": "inline" }),
            )
        } else {
            let params = self.turn_params(&prompt, plan).await;
            self.client.request("turn/start", params)
        };
        let replies = self.replies.clone();
        tokio::spawn(async move {
            let _ = replies.send(Reply::TurnStarted(request.await));
        });
        Ok(())
    }

    async fn turn_params(&self, prompt: &Prompt, plan: bool) -> Value {
        let text = attachments::prompt_with_attachments(&prompt.text, &prompt.files);
        let mut input = vec![json!({ "type": "text", "text": text, "text_elements": [] })];
        for path in attachments::image_paths(&prompt.files).await {
            input.push(json!({ "type": "localImage", "path": path }));
        }
        for skill in skills::mentioned(&prompt.text, &self.skills) {
            input.push(json!({ "type": "skill", "name": skill.name, "path": skill.path }));
        }
        let mut params = json!({
            "threadId": self.thread_id,
            "input": input,
            // Each turn names its mode: approving a plan ran one in default.
            "collaborationMode": {
                "mode": if plan { "plan" } else { "default" },
                "settings": {
                    "model": self.model,
                    "reasoning_effort": self.effort,
                    "developer_instructions": null,
                },
            },
        });
        if let Some(effort) = self.effort {
            params["effort"] = json!(effort);
        }
        if let Some(tier) = &self.service_tier {
            params["serviceTier"] = json!(tier);
        }
        params
    }

    async fn on_reply(&mut self, reply: Reply) -> Result<(), Gone> {
        match reply {
            Reply::Skills(skills) => {
                self.skills_cache
                    .lock()
                    .unwrap()
                    .insert(self.folder.clone(), skills.clone());
                self.skills = skills;
                self.report_commands().await
            }
            Reply::TurnStarted(Ok(result)) => {
                if let (Some(turn), Some(id)) = (&mut self.turn, result["turn"]["id"].as_str()) {
                    if turn.id.is_none() {
                        turn.id = Some(id.to_owned());
                        if turn.interrupt_pending {
                            self.send_interrupt();
                        }
                    }
                }
                Ok(())
            }
            Reply::TurnStarted(Err(message)) => {
                // Refused before it began: the turn ends here.
                if self
                    .turn
                    .as_ref()
                    .is_some_and(|t| t.id.is_none() && !t.awaiting_plan)
                {
                    self.end_turn(DoneStatus::Errored, Some(message)).await?;
                }
                Ok(())
            }
        }
    }

    async fn report_commands(&mut self) -> Result<(), Gone> {
        if self.title {
            return Ok(());
        }
        let commands = skills::commands(&self.skills);
        self.emit(AgentEvent::AvailableCommands { commands }).await
    }

    async fn on_notification(&mut self, method: &str, params: &Value) -> Result<(), Gone> {
        let main = params["threadId"].as_str() == Some(self.thread_id.as_str());
        match method {
            "turn/started" if main => {
                let id = params["turn"]["id"].as_str().map(str::to_owned);
                if let Some(turn) = &mut self.turn {
                    if turn.id.is_none() && !turn.awaiting_plan {
                        turn.id = id;
                        if turn.interrupt_pending {
                            self.send_interrupt();
                        }
                    }
                }
                Ok(())
            }
            "turn/completed" if main => {
                let turn = &params["turn"];
                let id = turn["id"].as_str().unwrap_or_default();
                if let Some(at) = self.settled.iter().position(|s| s == id) {
                    self.settled.remove(at);
                    return Ok(());
                }
                let ours = self
                    .turn
                    .as_ref()
                    .is_some_and(|t| !t.awaiting_plan && t.id.as_deref().is_none_or(|t| t == id));
                if !ours {
                    return Ok(());
                }
                let status = match turn["status"].as_str() {
                    Some("interrupted") => DoneStatus::Interrupted,
                    Some("failed") => DoneStatus::Errored,
                    _ => DoneStatus::Completed,
                };
                let error = (status == DoneStatus::Errored).then(|| {
                    turn["error"]["message"]
                        .as_str()
                        .map(str::to_owned)
                        .or_else(|| self.normalizer.last_error.clone())
                        .unwrap_or_else(|| "Codex couldn't finish this turn.".into())
                });
                self.on_turn_completed(status, error).await
            }
            "serverRequest/resolved" => {
                let rpc = &params["requestId"];
                let resolved: Vec<String> =
                    self.pending
                        .iter()
                        .filter(|(_, p)| match p {
                            Pending::Approval { rpc_id, .. }
                            | Pending::Questions { rpc_id, .. } => rpc_id == rpc,
                            Pending::Plan { .. } => false,
                        })
                        .map(|(id, _)| id.clone())
                        .collect();
                for request_id in resolved {
                    self.pending.remove(&request_id);
                    self.emit(AgentEvent::InputResolved { request_id }).await?;
                }
                Ok(())
            }
            _ => {
                for event in self.normalizer.notification(method, params) {
                    self.emit(event).await?;
                }
                Ok(())
            }
        }
    }

    /// A plan-mode turn that produced a plan goes on to implement it once
    /// approved (at once in full access), as Claude's `ExitPlanMode` does.
    async fn on_turn_completed(
        &mut self,
        status: DoneStatus,
        error: Option<String>,
    ) -> Result<(), Gone> {
        let planned = status == DoneStatus::Completed
            && self.turn.as_ref().is_some_and(|t| t.plan)
            && self.normalizer.plan_seen
            && !self.closing;
        if !planned {
            return self.end_turn(status, error).await;
        }
        if self.access.is_full_access() {
            return self.implement().await;
        }
        self.plans += 1;
        let request_id = format!("codex-plan-{}", self.plans);
        let question = approval::question(
            "Approve plan",
            "Codex wants to start implementing its plan. Allow it?",
        );
        if let Some(turn) = &mut self.turn {
            turn.awaiting_plan = true;
            turn.id = None;
        }
        self.pending.insert(
            request_id.clone(),
            Pending::Plan {
                question: question.clone(),
            },
        );
        self.emit(AgentEvent::InputRequested {
            request_id,
            questions: vec![question],
        })
        .await
    }

    async fn implement(&mut self) -> Result<(), Gone> {
        self.begin(
            Prompt {
                text: IMPLEMENT_PROMPT.into(),
                files: Vec::new(),
            },
            false,
        )
        .await
    }

    /// Reports the turn's end, drops what it left asking, and starts the
    /// next queued prompt.
    async fn end_turn(&mut self, status: DoneStatus, error: Option<String>) -> Result<(), Gone> {
        self.turn = None;
        self.interrupt_deadline = None;
        let open: Vec<String> = self.pending.drain().map(|(id, _)| id).collect();
        for request_id in open {
            self.emit(AgentEvent::InputResolved { request_id }).await?;
        }
        self.emit(AgentEvent::Done {
            status,
            error,
            session_id: Some(self.thread_id.clone()),
        })
        .await?;
        if !self.closing {
            if let Some(next) = self.queue.pop_front() {
                self.begin(next, true).await?;
            }
        }
        Ok(())
    }

    fn send_interrupt(&mut self) {
        let Some(turn) = &mut self.turn else {
            return;
        };
        let Some(id) = &turn.id else {
            turn.interrupt_pending = true;
            return;
        };
        turn.interrupt_pending = false;
        let request = self.client.request(
            "turn/interrupt",
            json!({ "threadId": self.thread_id, "turnId": id }),
        );
        tokio::spawn(request);
    }

    /// The interrupted turn never reported; end it here.
    async fn settle_interrupt(&mut self) -> Result<(), Gone> {
        if let Some(id) = self.turn.as_ref().and_then(|t| t.id.clone()) {
            self.settled.push(id);
        }
        self.end_turn(DoneStatus::Interrupted, None).await
    }

    async fn on_command(&mut self, command: RunCommand) -> Result<(), Gone> {
        match command {
            RunCommand::Send {
                prompt,
                attachments,
            } => {
                if self.closing {
                    return Ok(());
                }
                let prompt = Prompt {
                    text: prompt,
                    files: attachments,
                };
                if self.turn.is_some() {
                    self.queue.push_back(prompt);
                    Ok(())
                } else {
                    self.begin(prompt, true).await
                }
            }
            RunCommand::Answer {
                request_id,
                answers,
            } => self.answer(request_id, answers).await,
            RunCommand::Interrupt => {
                let Some(turn) = &self.turn else {
                    return Ok(());
                };
                if turn.awaiting_plan {
                    return self.end_turn(DoneStatus::Interrupted, None).await;
                }
                if self.interrupt_deadline.is_none() {
                    self.send_interrupt();
                    self.interrupt_deadline = Some(tokio::time::Instant::now() + INTERRUPT_SETTLE);
                }
                Ok(())
            }
            RunCommand::StopTask { .. } => Ok(()),
            RunCommand::TaskOutput { reply, .. } => {
                let _ = reply.send(Err("Codex doesn't share background task output.".into()));
                Ok(())
            }
            RunCommand::Close => {
                self.closing = true;
                self.queue.clear();
                Ok(())
            }
        }
    }

    async fn answer(
        &mut self,
        request_id: String,
        answers: Vec<UserInputAnswer>,
    ) -> Result<(), Gone> {
        let Some(pending) = self.pending.remove(&request_id) else {
            return Ok(());
        };
        self.emit(AgentEvent::InputResolved {
            request_id: request_id.clone(),
        })
        .await?;
        match pending {
            Pending::Questions { rpc_id, questions } => {
                let mut by_id = Map::new();
                for question in &questions {
                    let labels = answers
                        .iter()
                        .find(|a| a.question_id == question.id)
                        .map(|a| a.labels.clone())
                        .unwrap_or_default();
                    by_id.insert(question.id.clone(), json!({ "answers": labels }));
                }
                self.client.respond(&rpc_id, json!({ "answers": by_id }));
                Ok(())
            }
            Pending::Approval {
                rpc_id,
                question,
                kind,
            } => {
                let yes = approval::approved(&question, &answers);
                self.client.respond(&rpc_id, approval_response(&kind, yes));
                Ok(())
            }
            Pending::Plan { question } => {
                if approval::approved(&question, &answers) {
                    self.implement().await
                } else {
                    self.end_turn(DoneStatus::Completed, None).await
                }
            }
        }
    }

    async fn on_request(&mut self, id: Value, method: &str, params: &Value) -> Result<(), Gone> {
        let item = params["itemId"].as_str().unwrap_or_default();
        let (question, kind) = match method {
            "item/commandExecution/requestApproval" => {
                if approval::allowed_without_asking(self.access, Action::Other) {
                    self.client.respond(&id, json!({ "decision": "accept" }));
                    return Ok(());
                }
                let command = self
                    .normalizer
                    .command(item)
                    .map(str::to_owned)
                    .or_else(|| params["command"].as_str().map(str::to_owned))
                    .unwrap_or_default();
                (approval::command("Codex", &command), ApprovalKind::Decision)
            }
            "item/fileChange/requestApproval" => {
                if approval::allowed_without_asking(self.access, Action::Edit) {
                    self.client.respond(&id, json!({ "decision": "accept" }));
                    return Ok(());
                }
                let paths: Vec<&str> = self
                    .normalizer
                    .paths(item)
                    .iter()
                    .map(String::as_str)
                    .collect();
                (approval::edit("Codex", &paths), ApprovalKind::Decision)
            }
            "item/permissions/requestApproval" => {
                let kind = ApprovalKind::Permissions(params["permissions"].clone());
                if self.access.is_full_access() {
                    self.client.respond(&id, approval_response(&kind, true));
                    return Ok(());
                }
                (
                    approval::tool("Codex", "extra permissions", params["reason"].as_str()),
                    kind,
                )
            }
            "mcpServer/elicitation/request" => {
                let mode = params["mode"].as_str().unwrap_or_default();
                if !matches!(mode, "form" | "openai/form" | "openaiForm") {
                    self.client
                        .respond(&id, approval_response(&ApprovalKind::Elicitation, false));
                    return Ok(());
                }
                if self.access.is_full_access() {
                    self.client
                        .respond(&id, approval_response(&ApprovalKind::Elicitation, true));
                    return Ok(());
                }
                let server = params["serverName"].as_str().unwrap_or("An MCP server");
                let message = params["message"].as_str().unwrap_or_default().trim();
                (
                    approval::question("Approve tool", format!("{server}: {message}")),
                    ApprovalKind::Elicitation,
                )
            }
            "item/tool/requestUserInput" => {
                let questions = user_questions(params);
                let request_id = request_key(&id);
                self.pending.insert(
                    request_id.clone(),
                    Pending::Questions {
                        rpc_id: id,
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
            "item/tool/call" => {
                self.client
                    .respond(&id, json!({ "contentItems": [], "success": false }));
                return Ok(());
            }
            "currentTime/read" => {
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs())
                    .unwrap_or_default();
                self.client.respond(&id, json!({ "currentTimeAt": now }));
                return Ok(());
            }
            _ => {
                self.client
                    .respond_error(&id, "Hive doesn't handle this request.");
                return Ok(());
            }
        };
        if self.title {
            // A title run asks nothing.
            self.client.respond(&id, approval_response(&kind, false));
            return Ok(());
        }
        let request_id = request_key(&id);
        self.pending.insert(
            request_id.clone(),
            Pending::Approval {
                rpc_id: id,
                question: question.clone(),
                kind,
            },
        );
        self.emit(AgentEvent::InputRequested {
            request_id,
            questions: vec![question],
        })
        .await
    }

    /// The server exited or the run closed. A turn still in flight ends here.
    async fn finish(self) {
        let in_flight = self.turn.is_some();
        let Session {
            client,
            mut child,
            stderr_tail,
            events,
            thread_id,
            closing,
            ..
        } = self;
        drop(client); // Closes stdin: the server exits.
        let status = match tokio::time::timeout(EXIT_GRACE, child.wait()).await {
            Ok(status) => status.ok(),
            Err(_) => {
                let _ = child.kill().await;
                None
            }
        };
        if !in_flight {
            return;
        }
        let (status, error) = if closing {
            (DoneStatus::Interrupted, None)
        } else {
            let stderr = stderr_tail.lock().unwrap().trim().to_owned();
            let code = status
                .and_then(|s| s.code())
                .map_or("unknown".to_owned(), |c| c.to_string());
            let mut message = format!("codex exited unexpectedly (exit code {code}).");
            if !stderr.is_empty() {
                message.push_str(&format!("\n{stderr}"));
            }
            (DoneStatus::Errored, Some(message))
        };
        let _ = events
            .send(AgentEvent::Done {
                status,
                error,
                session_id: Some(thread_id),
            })
            .await;
    }

    async fn emit(&self, event: AgentEvent) -> Result<(), Gone> {
        self.events.send(event).await.map_err(|_| Gone)
    }
}

/// The UI's request id for a server request.
fn request_key(id: &Value) -> String {
    match id {
        Value::String(s) => format!("codex-{s}"),
        other => format!("codex-{other}"),
    }
}

fn approval_response(kind: &ApprovalKind, yes: bool) -> Value {
    match kind {
        ApprovalKind::Decision => json!({ "decision": if yes { "accept" } else { "decline" } }),
        ApprovalKind::Permissions(asked) => {
            let mut granted = Map::new();
            if yes {
                for key in ["network", "fileSystem"] {
                    if let Some(value) = asked.get(key).filter(|v| !v.is_null()) {
                        granted.insert(key.into(), value.clone());
                    }
                }
            }
            json!({ "permissions": granted, "scope": "turn" })
        }
        ApprovalKind::Elicitation => {
            if yes {
                json!({ "action": "accept", "content": {}, "_meta": null })
            } else {
                json!({ "action": "decline", "content": null, "_meta": null })
            }
        }
    }
}

/// `item/tool/requestUserInput` questions; option descriptions are dropped.
fn user_questions(params: &Value) -> Vec<UserInputQuestion> {
    params["questions"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .enumerate()
        .map(|(i, q)| UserInputQuestion {
            id: q["id"]
                .as_str()
                .map_or_else(|| format!("q{i}"), str::to_owned),
            header: q["header"]
                .as_str()
                .filter(|h| !h.is_empty())
                .unwrap_or("Question")
                .to_owned(),
            question: q["question"].as_str().unwrap_or_default().to_owned(),
            options: q["options"]
                .as_array()
                .map(Vec::as_slice)
                .unwrap_or_default()
                .iter()
                .filter_map(|o| o["label"].as_str().map(str::to_owned))
                .collect(),
            multi_select: false,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(access: AccessMode, auto: bool) -> RunRequest {
        let mut r: RunRequest = serde_json::from_value(json!({
            "harness": "codex", "prompt": "p", "cwd": "/w", "sandbox": "workspace-write", "model": "m",
        }))
        .unwrap();
        r.access = access;
        r.auto_approve = auto;
        r
    }

    #[test]
    fn mcp_server_rides_as_dotted_overrides_but_not_on_titles() {
        let mut r = request(AccessMode::Supervised, false);
        r.mcp = Some(McpServer {
            name: "hive".into(),
            command: "/opt/hive".into(),
            args: vec!["mcp".into()],
            env: [("HIVE_CHAT_ID".to_owned(), "c1".to_owned())].into(),
        });
        let p = thread_params(&r, false);
        assert_eq!(p["config"]["mcp_servers.hive.command"], "/opt/hive");
        assert_eq!(p["config"]["mcp_servers.hive.args"], json!(["mcp"]));
        assert_eq!(p["config"]["mcp_servers.hive.env"], json!({"HIVE_CHAT_ID": "c1"}));
        assert_eq!(p["config"]["mcp_servers.hive.default_tools_approval_mode"], "approve");
        assert_eq!(p["config"]["mcp_servers.hive.tool_timeout_sec"], 3900);
        assert!(thread_params(&r, true).get("config").is_none());
    }

    #[test]
    fn access_maps_onto_policy_and_sandbox() {
        let p = thread_params(&request(AccessMode::FullAccess, false), false);
        assert_eq!(p["approvalPolicy"], "never");
        assert_eq!(p["sandbox"], "workspace-write");
        let p = thread_params(&request(AccessMode::Supervised, false), false);
        assert_eq!(p["approvalPolicy"], "untrusted");
        let p = thread_params(&request(AccessMode::Supervised, true), false);
        assert_eq!(p["approvalPolicy"], "never");
        assert_eq!(p["sandbox"], "danger-full-access");
        let p = thread_params(&request(AccessMode::FullAccess, false), true);
        assert_eq!(p["sandbox"], "read-only");
        assert_eq!(p["ephemeral"], true);
    }

    #[test]
    fn answers_and_grants() {
        assert_eq!(
            approval_response(&ApprovalKind::Decision, false),
            json!({ "decision": "decline" })
        );
        let asked = json!({ "network": { "enabled": true }, "fileSystem": null });
        assert_eq!(
            approval_response(&ApprovalKind::Permissions(asked), true),
            json!({ "permissions": { "network": { "enabled": true } }, "scope": "turn" })
        );
        let q = user_questions(&json!({ "questions": [
            { "id": "a", "header": "", "question": "Which?", "options": [{ "label": "X", "description": "" }] }
        ]}));
        assert_eq!(q[0].header, "Question");
        assert_eq!(q[0].options, ["X"]);
        assert_eq!(request_key(&json!(3)), "codex-3");
    }
}
