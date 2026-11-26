//! One run: a `codex app-server` holding one thread, a turn at a time.

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use outcode_proto::{
    AccessMode, AgentEvent, ApprovalDecision, DoneStatus, InputRequest, InputResponse, McpServer, RunRequest,
    ToolCall, UserInputOption, UserInputQuestion,
};
use serde_json::{Map, Value, json};
use tokio::process::Child;
use tokio::sync::mpsc;
use tokio::time::Instant;

use super::models::{FAST_TIER, effort};
use super::normalize::{Normalizer, unwrap_shell};
use super::rpc::{self, Client, Incoming, Server};
use super::skills::{self, Builtin, Skill};
use crate::cli::{StderrTail, sleep_until};
use crate::{Gone, Run, RunCommand, RunHandle, attachments, cli};

/// How long an interrupted turn may take to report its end before the run
/// reports it interrupted anyway.
const INTERRUPT_SETTLE: Duration = Duration::from_secs(5);
/// The turn an approved plan runs, in default mode.
const IMPLEMENT_PROMPT: &str = "Implement the plan.";
/// What `thread/sample` asks for after a completed turn: the user's next prompt.
const SUGGESTION_PROMPT: &str = "Predict the next message the user will send in this conversation. Reply with \
    only that message, written as the user would type it, in under 20 words. Do not use tools. If there is \
    no clear next step, reply with nothing.";

/// What the session was started for.
pub(super) struct Launch {
    pub exe: PathBuf,
    pub request: RunRequest,
    /// A text run: ephemeral, read-only thread, text instructions, nothing
    /// asked.
    pub text: bool,
    /// Skills known from earlier runs, by folder, refreshed here.
    pub skills: Arc<Mutex<HashMap<String, Vec<Skill>>>>,
}

pub(super) fn start(launch: Launch) -> Run {
    let (events_tx, events) = mpsc::channel(256);
    let (handle, commands) = RunHandle::new();
    tokio::spawn(async move {
        let cwd = working_dir(&launch.request.cwd);
        let opened = match Server::start(&launch.exe, cwd.as_deref()).await {
            Ok(server) => Session::open(server, &launch, cwd, events_tx.clone()).await,
            Err(e) => Err(e.to_string()),
        };
        match opened {
            Ok(session) => {
                let RunRequest { prompt, attachments, .. } = launch.request;
                session.run(Prompt { text: prompt, files: attachments }, commands).await;
            }
            Err(message) => {
                let _ = events_tx.send(AgentEvent::Error { message }).await;
                let _ = events_tx.send(AgentEvent::Done { status: DoneStatus::Errored }).await;
            }
        }
    });
    Run { events, handle }
}

/// Where a run works: `cwd`, else the home folder.
fn working_dir(cwd: &str) -> Option<PathBuf> {
    match cwd.trim() {
        "" => cli::home_dir(),
        cwd => Some(PathBuf::from(cwd)),
    }
}

struct Prompt {
    text: String,
    files: Vec<String>,
}

/// The turn in flight, from our request until its end is reported.
struct Turn {
    /// Known once the server says.
    id: Option<String>,
    /// Plan mode: a plan it ends with is offered for implementing.
    plan: bool,
    /// Asked to stop before its id was known.
    interrupt_pending: bool,
    /// Waiting on whether to implement its plan; no model turn runs meanwhile.
    awaiting_plan: bool,
}

/// What waits on the user, keyed by the request id the UI answers.
enum Pending {
    Approval { rpc_id: Value, kind: ApprovalKind },
    Questions { rpc_id: Value },
    Plan,
}

#[derive(Debug, Clone, PartialEq)]
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
    /// `thread/sample`'s guess after the turn `turn_id`.
    Suggestion { turn_id: String, text: String },
}

struct Session {
    client: Client,
    child: Child,
    incoming: mpsc::Receiver<Incoming>,
    stderr: StderrTail,
    events: mpsc::Sender<AgentEvent>,
    normalizer: Normalizer,
    thread_id: String,
    model: String,
    /// The folder as requested: the skills cache's key.
    folder: String,
    access: AccessMode,
    /// Turns start in plan mode.
    plan: bool,
    effort: Option<&'static str>,
    fast: bool,
    text: bool,
    skills: Vec<Skill>,
    skills_cache: Arc<Mutex<HashMap<String, Vec<Skill>>>>,
    /// Told as the first turn starts: the old thread couldn't be resumed.
    resume_note: Option<String>,
    turn: Option<Turn>,
    queue: VecDeque<Prompt>,
    pending: HashMap<String, Pending>,
    /// Turns that ended here before the server said so (an interrupt that
    /// didn't settle); their late `turn/completed` is dropped.
    settled: Vec<String>,
    interrupt_deadline: Option<Instant>,
    replies: mpsc::UnboundedSender<Reply>,
    replies_rx: mpsc::UnboundedReceiver<Reply>,
    closing: bool,
    plans: u64,
    /// Sample a next-prompt suggestion after each completed turn.
    suggest: bool,
    /// The completed turn a suggestion is being sampled for; none once
    /// another starts.
    sampled: Option<String>,
}

/// A run in full access is never asked; otherwise every command that isn't
/// known safe is, and the access mode decides here which reach the user.
fn approval_policy(access: AccessMode, text: bool) -> &'static str {
    if text || access == AccessMode::FullAccess {
        "never"
    } else {
        "untrusted"
    }
}

/// `thread/start` (or `thread/resume`) parameters. Full access runs
/// unsandboxed, as a chat's agent does with Claude; the other modes keep
/// the user's own sandbox.
fn thread_params(request: &RunRequest, cwd: Option<&str>, text: bool) -> Map<String, Value> {
    let config = &request.config;
    let mut params = Map::new();
    if let Some(cwd) = cwd {
        params.insert("cwd".into(), json!(cwd));
    }
    if let Some(model) = config.model.as_deref().filter(|m| !m.is_empty()) {
        params.insert("model".into(), json!(model));
    }
    params.insert("approvalPolicy".into(), json!(approval_policy(config.access, text)));
    if text {
        params.insert("sandbox".into(), json!("read-only"));
        params.insert("baseInstructions".into(), json!(crate::TEXT_INSTRUCTIONS));
        params.insert("ephemeral".into(), json!(true));
    } else {
        if config.access == AccessMode::FullAccess {
            params.insert("sandbox".into(), json!("danger-full-access"));
        }
        if let Some(mcp) = &request.mcp {
            params.insert("config".into(), Value::Object(mcp_overrides(mcp)));
        }
    }
    if config.fast_mode() {
        params.insert("serviceTier".into(), json!(FAST_TIER));
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
    // Outcode's own tools: approved in every access mode, so Codex neither
    // rejects a call under `never` nor asks about one under the others.
    config.insert(key("default_tools_approval_mode"), json!("approve"));
    // ⚠ Its calls may wait on the user; Codex cuts them off after 60s.
    config.insert(key("tool_timeout_sec"), json!(McpServer::TOOL_TIMEOUT_SECS));
    config
}

impl Session {
    async fn open(
        server: Server,
        launch: &Launch,
        cwd: Option<PathBuf>,
        events: mpsc::Sender<AgentEvent>,
    ) -> Result<Self, String> {
        let request = &launch.request;
        let Server {
            mut child,
            client,
            incoming,
            stderr,
        } = server;
        let cwd = cwd.map(|c| c.to_string_lossy().into_owned());
        let params = thread_params(request, cwd.as_deref(), launch.text);
        let mut resume_note = None;
        let opened = match request.resume.as_deref().filter(|r| !r.is_empty() && !launch.text) {
            Some(thread) => {
                let mut resume = params.clone();
                resume.insert("threadId".into(), json!(thread));
                resume.insert("excludeTurns".into(), json!(true));
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
            None => client.request("thread/start", Value::Object(params)).await,
        };
        let opened = match opened {
            Ok(opened) => opened,
            Err(e) => {
                let message = stderr.under(format!("Codex couldn't start a session: {e}"));
                drop(client);
                tokio::spawn(async move { rpc::retire(&mut child).await });
                return Err(message);
            }
        };
        let thread_id = opened["thread"]["id"].as_str().unwrap_or_default().to_owned();
        let model = opened["model"]
            .as_str()
            .map(str::to_owned)
            .or_else(|| request.config.model.clone())
            .unwrap_or_default();

        let (replies, replies_rx) = mpsc::unbounded_channel();
        let skills = launch
            .skills
            .lock()
            .unwrap()
            .get(&request.cwd)
            .cloned()
            .unwrap_or_default();
        let session = Self {
            normalizer: Normalizer::new(thread_id.clone()),
            client,
            child,
            incoming,
            stderr,
            events,
            thread_id,
            model,
            folder: request.cwd.clone(),
            access: if launch.text { AccessMode::Supervised } else { request.config.access },
            plan: request.config.plan && !launch.text,
            effort: request.config.reasoning.map(effort),
            fast: request.config.fast_mode(),
            text: launch.text,
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
            suggest: request.prompt_suggestions && !launch.text,
            sampled: None,
        };
        if !launch.text {
            session.list_skills();
        }
        Ok(session)
    }

    async fn run(mut self, first: Prompt, mut commands: mpsc::UnboundedReceiver<RunCommand>) {
        let started = async {
            self.report_commands().await?;
            let plan = self.plan;
            self.begin(first, true, plan).await
        };
        if started.await.is_err() {
            return self.abandon();
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
                        // Every handle dropped.
                        commands_open = false;
                        self.close().await
                    }
                },
                Some(reply) = self.replies_rx.recv() => self.on_reply(reply).await,
                _ = sleep_until(self.interrupt_deadline) => self.settle_interrupt().await,
            };
            if outcome.is_err() {
                return self.abandon();
            }
            if self.closing && self.turn.is_none() {
                break;
            }
        }
        self.finish().await;
    }

    /// Starts a turn: the user's (`user`: a prompt of theirs, so the session
    /// is reported first), or one the session runs for them (implementing
    /// or refining a plan) within the same reply.
    async fn begin(&mut self, prompt: Prompt, user: bool, plan: bool) -> Result<(), Gone> {
        if user {
            let session_id = self.thread_id.clone();
            self.emit(AgentEvent::SessionStarted { session_id }).await?;
            if let Some(message) = self.resume_note.take() {
                self.emit(AgentEvent::Error { message }).await?;
            }
        }
        self.sampled = None;
        self.normalizer.start_turn();
        self.turn = Some(Turn {
            id: None,
            plan,
            interrupt_pending: false,
            awaiting_plan: false,
        });
        let builtin = skills::builtin_of(&prompt.text).filter(|_| prompt.files.is_empty() && !self.text);
        let thread = self.thread_id.clone();
        let request = match builtin {
            Some(Builtin::Compact) => {
                self.normalizer.compact_turn = true;
                self.client.request("thread/compact/start", json!({ "threadId": thread }))
            }
            Some(Builtin::Review(instructions)) => {
                let target = if instructions.is_empty() {
                    json!({ "type": "uncommittedChanges" })
                } else {
                    json!({ "type": "custom", "instructions": instructions })
                };
                let params = json!({ "threadId": thread, "target": target, "delivery": "inline" });
                self.client.request("review/start", params)
            }
            None => {
                let params = self.turn_params(&prompt, plan).await;
                self.client.request("turn/start", params)
            }
        };
        let replies = self.replies.clone();
        tokio::spawn(async move {
            let _ = replies.send(Reply::TurnStarted(request.await));
        });
        Ok(())
    }

    /// `turn/start` parameters. Each turn names its mode (approving a plan
    /// runs one in default) and the access mode's approval policy, so a
    /// change of either applies from the next turn.
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
            "approvalPolicy": approval_policy(self.access, self.text),
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
        if self.fast {
            params["serviceTier"] = json!(FAST_TIER);
        }
        if self.access == AccessMode::FullAccess && !self.text {
            params["sandboxPolicy"] = json!({ "type": "dangerFullAccess" });
        }
        params
    }

    /// Asks for a guess at the user's next prompt after the completed turn
    /// `turn_id`, best effort: older Codex lacks `thread/sample`, and it fails
    /// once another turn starts.
    fn sample_suggestion(&mut self, turn_id: &str) {
        if !self.suggest || self.closing {
            return;
        }
        self.sampled = Some(turn_id.to_owned());
        let params = json!({
            "threadId": self.thread_id,
            "expectedTurnId": turn_id,
            "prompt": SUGGESTION_PROMPT,
            "effort": "low",
        });
        let sample = self.client.request("thread/sample", params);
        let replies = self.replies.clone();
        let turn_id = turn_id.to_owned();
        tokio::spawn(async move {
            let Ok(result) = sample.await else {
                return;
            };
            let text = result["text"].as_str().unwrap_or_default().trim().to_owned();
            if !text.is_empty() {
                let _ = replies.send(Reply::Suggestion { turn_id, text });
            }
        });
    }

    fn list_skills(&self) {
        let list = self.client.request("skills/list", json!({ "cwds": [self.folder] }));
        let replies = self.replies.clone();
        tokio::spawn(async move {
            if let Ok(result) = list.await {
                let _ = replies.send(Reply::Skills(skills::parse(&result)));
            }
        });
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
            Reply::Suggestion { turn_id, text } => {
                if self.turn.is_none() && !self.closing && self.sampled.as_deref() == Some(turn_id.as_str()) {
                    self.sampled = None;
                    self.emit(AgentEvent::PromptSuggestion { text }).await?;
                }
                Ok(())
            }
            Reply::TurnStarted(Ok(result)) => {
                if let Some(id) = result["turn"]["id"].as_str() {
                    self.turn_started(id);
                }
                Ok(())
            }
            Reply::TurnStarted(Err(message)) => {
                // Refused before it began: the turn ends here.
                if self.turn.as_ref().is_some_and(|t| t.id.is_none() && !t.awaiting_plan) {
                    self.end_turn(DoneStatus::Errored, Some(message)).await?;
                }
                Ok(())
            }
        }
    }

    /// The turn in flight is `id`; an interrupt that waited on it goes now.
    fn turn_started(&mut self, id: &str) {
        let Some(turn) = &mut self.turn else {
            return;
        };
        if turn.id.is_some() || turn.awaiting_plan {
            return;
        }
        turn.id = Some(id.to_owned());
        if turn.interrupt_pending {
            self.send_interrupt();
        }
    }

    async fn report_commands(&mut self) -> Result<(), Gone> {
        if self.text {
            return Ok(());
        }
        let commands = skills::commands(&self.skills);
        self.emit(AgentEvent::AvailableCommands { commands }).await
    }

    async fn on_notification(&mut self, method: &str, params: &Value) -> Result<(), Gone> {
        let main = params["threadId"].as_str() == Some(self.thread_id.as_str());
        match method {
            "turn/started" if main => {
                let id = params["turn"]["id"].as_str().unwrap_or_default();
                if self.turn.is_none() && !self.closing && !self.text {
                    // A turn Codex started on its own: a reply of its own.
                    self.emit(AgentEvent::BackgroundTurn { finished: Vec::new() }).await?;
                    self.normalizer.start_turn();
                    self.turn = Some(Turn {
                        id: Some(id.to_owned()),
                        plan: false,
                        interrupt_pending: false,
                        awaiting_plan: false,
                    });
                    return Ok(());
                }
                self.turn_started(id);
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
                let mut status = super::normalize::turn_status(turn);
                // Stopping fails the turn; that's no error.
                if self.interrupt_deadline.is_some() {
                    status = DoneStatus::Interrupted;
                }
                let error = (status == DoneStatus::Errored).then(|| {
                    turn["error"]["message"]
                        .as_str()
                        .map(str::to_owned)
                        .or_else(|| self.normalizer.last_error.clone())
                        .unwrap_or_else(|| "Codex couldn't finish this turn.".into())
                });
                self.on_turn_completed(status, error).await?;
                if status == DoneStatus::Completed && self.turn.is_none() && !id.is_empty() {
                    self.sample_suggestion(id);
                }
                Ok(())
            }
            "serverRequest/resolved" => {
                let rpc = &params["requestId"];
                let resolved: Vec<String> = self
                    .pending
                    .iter()
                    .filter(|(_, p)| match p {
                        Pending::Approval { rpc_id, .. } | Pending::Questions { rpc_id } => rpc_id == rpc,
                        Pending::Plan => false,
                    })
                    .map(|(id, _)| id.clone())
                    .collect();
                for request_id in resolved {
                    self.pending.remove(&request_id);
                    self.emit(AgentEvent::InputResolved {
                        request_id,
                        response: None,
                    })
                    .await?;
                }
                Ok(())
            }
            "skills/changed" => {
                if !self.text {
                    self.list_skills();
                }
                Ok(())
            }
            _ => {
                let between = self.turn.is_none();
                for event in self.normalizer.notification(method, params) {
                    // Between turns only session state and subagents still
                    // working have anything to say.
                    if between && !matches!(event, AgentEvent::Subagent { .. } | AgentEvent::ContextUsage { .. }) {
                        continue;
                    }
                    self.emit(event).await?;
                }
                Ok(())
            }
        }
    }

    /// A plan-mode turn that produced a plan asks whether to implement it,
    /// as Claude's `ExitPlanMode` does: always, whatever the access mode.
    async fn on_turn_completed(&mut self, status: DoneStatus, error: Option<String>) -> Result<(), Gone> {
        let planned = status == DoneStatus::Completed
            && self.turn.as_ref().is_some_and(|t| t.plan)
            && !self.normalizer.plan.trim().is_empty()
            && !self.closing;
        if !planned {
            return self.end_turn(status, error).await;
        }
        self.plans += 1;
        let request_id = format!("codex-plan-{}", self.plans);
        if let Some(turn) = &mut self.turn {
            turn.awaiting_plan = true;
            turn.id = None;
        }
        self.pending.insert(request_id.clone(), Pending::Plan);
        let plan = self.normalizer.plan.trim().to_owned();
        self.emit(AgentEvent::InputRequested {
            request_id,
            request: InputRequest::Plan { plan },
        })
        .await
    }

    /// Reports the turn's end, drops what it left asking, and starts the
    /// next queued prompt.
    async fn end_turn(&mut self, status: DoneStatus, error: Option<String>) -> Result<(), Gone> {
        self.turn = None;
        self.interrupt_deadline = None;
        if let Some(message) = error {
            self.emit(AgentEvent::Error { message }).await?;
        }
        let open: Vec<String> = self.pending.drain().map(|(id, _)| id).collect();
        for request_id in open {
            self.emit(AgentEvent::InputResolved {
                request_id,
                response: None,
            })
            .await?;
        }
        self.emit(AgentEvent::Done { status }).await?;
        if !self.closing
            && let Some(next) = self.queue.pop_front()
        {
            let plan = self.plan;
            self.begin(next, true, plan).await?;
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
        let params = json!({ "threadId": self.thread_id, "turnId": id });
        self.client.fire("turn/interrupt", params);
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
            RunCommand::Send { prompt, attachments } => {
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
                    let plan = self.plan;
                    self.begin(prompt, true, plan).await
                }
            }
            RunCommand::Answer { request_id, response } => self.answer(request_id, response).await,
            RunCommand::SetModes { access, plan } => {
                // Every turn names both: they apply from the next one.
                self.access = access;
                self.plan = plan;
                Ok(())
            }
            // Codex keeps no background tasks of its own to stop.
            RunCommand::StopTask { .. } => Ok(()),
            RunCommand::Interrupt => {
                let Some(turn) = &self.turn else {
                    return Ok(());
                };
                // Nothing of the model's runs while a plan waits.
                if turn.awaiting_plan {
                    return self.end_turn(DoneStatus::Interrupted, None).await;
                }
                if self.interrupt_deadline.is_some() {
                    return Ok(());
                }
                // Whatever the turn waited on is refused, so it can stop.
                for (_, pending) in self.pending.drain() {
                    match pending {
                        Pending::Approval { rpc_id, kind } => {
                            self.client.respond(&rpc_id, approval_response(&kind, ApprovalDecision::Deny));
                        }
                        Pending::Questions { rpc_id } => self.client.respond(&rpc_id, json!({ "answers": {} })),
                        Pending::Plan => {}
                    }
                }
                self.send_interrupt();
                self.interrupt_deadline = Some(Instant::now() + INTERRUPT_SETTLE);
                Ok(())
            }
            RunCommand::Close => self.close().await,
        }
    }

    /// Ends the session once the turn in flight ends; one waiting on its
    /// plan ends now.
    async fn close(&mut self) -> Result<(), Gone> {
        self.closing = true;
        self.queue.clear();
        if self.turn.as_ref().is_some_and(|t| t.awaiting_plan) {
            return self.end_turn(DoneStatus::Interrupted, None).await;
        }
        Ok(())
    }

    async fn answer(&mut self, request_id: String, response: InputResponse) -> Result<(), Gone> {
        let Some(pending) = self.pending.remove(&request_id) else {
            return Ok(());
        };
        self.emit(AgentEvent::InputResolved {
            request_id,
            response: Some(response.clone()),
        })
        .await?;
        match (pending, response) {
            (Pending::Questions { rpc_id }, response) => {
                let mut by_id = Map::new();
                if let InputResponse::Questions { answers } = response {
                    for answer in answers {
                        by_id.insert(answer.question_id, json!({ "answers": answer.labels }));
                    }
                }
                self.client.respond(&rpc_id, json!({ "answers": by_id }));
                Ok(())
            }
            (Pending::Approval { rpc_id, kind }, response) => {
                let decision = match response {
                    InputResponse::Approval { decision } => decision,
                    _ => ApprovalDecision::Deny,
                };
                self.client.respond(&rpc_id, approval_response(&kind, decision));
                Ok(())
            }
            (Pending::Plan, InputResponse::Plan { approve: true, .. }) => {
                // Implementing leaves plan mode.
                self.plan = false;
                let prompt = Prompt {
                    text: IMPLEMENT_PROMPT.into(),
                    files: Vec::new(),
                };
                self.begin(prompt, false, false).await
            }
            (Pending::Plan, InputResponse::Plan { feedback, .. }) => {
                match feedback.as_deref().map(str::trim).filter(|f| !f.is_empty()) {
                    // Keep planning, with what they'd change.
                    Some(feedback) => {
                        let prompt = Prompt {
                            text: format!("Revise the plan. My feedback: {feedback}"),
                            files: Vec::new(),
                        };
                        self.begin(prompt, false, true).await
                    }
                    None => self.end_turn(DoneStatus::Completed, None).await,
                }
            }
            (Pending::Plan, _) => self.end_turn(DoneStatus::Completed, None).await,
        }
    }

    async fn on_request(&mut self, id: Value, method: &str, params: &Value) -> Result<(), Gone> {
        let item = params["itemId"].as_str().unwrap_or_default();
        let reason = params["reason"]
            .as_str()
            .map(str::trim)
            .filter(|r| !r.is_empty())
            .map(str::to_owned);
        let full = self.access == AccessMode::FullAccess;
        let (request, kind, free) = match method {
            "item/commandExecution/requestApproval" => {
                let call = self.normalizer.call(item).cloned().unwrap_or_else(|| ToolCall::Exec {
                    command: unwrap_shell(params["command"].as_str().unwrap_or_default()),
                });
                let request = InputRequest::Approval {
                    title: "Run command".into(),
                    call: Some(call),
                    tool_call_id: Some(item.to_owned()).filter(|i| !i.is_empty()),
                    reason,
                };
                (request, ApprovalKind::Decision, full)
            }
            "item/fileChange/requestApproval" => {
                let files = self.normalizer.paths(item).len();
                let call_id = if files > 1 { format!("{item}:0") } else { item.to_owned() };
                let request = InputRequest::Approval {
                    title: if files > 1 { format!("Edit {files} files") } else { "Edit file".into() },
                    call: self.normalizer.call(item).cloned(),
                    tool_call_id: Some(call_id).filter(|i| !i.is_empty()),
                    reason,
                };
                let free = full || self.access == AccessMode::AutoAcceptEdits;
                (request, ApprovalKind::Decision, free)
            }
            "item/permissions/requestApproval" => {
                let request = InputRequest::Approval {
                    title: "Grant extra permissions".into(),
                    call: None,
                    tool_call_id: None,
                    reason,
                };
                (request, ApprovalKind::Permissions(params["permissions"].clone()), full)
            }
            "mcpServer/elicitation/request" => {
                let mode = params["mode"].as_str().unwrap_or_default();
                if !matches!(mode, "form" | "openai/form" | "openaiForm") {
                    // Nothing here can fill in a URL flow or a verification.
                    self.client
                        .respond(&id, approval_response(&ApprovalKind::Elicitation, ApprovalDecision::Deny));
                    return Ok(());
                }
                let server = params["serverName"].as_str().unwrap_or("an MCP server");
                let message = params["message"].as_str().unwrap_or_default().trim();
                let request = InputRequest::Approval {
                    title: format!("Allow {server}"),
                    call: None,
                    tool_call_id: None,
                    reason: Some(message.to_owned()).filter(|m| !m.is_empty()),
                };
                (request, ApprovalKind::Elicitation, full)
            }
            "item/tool/requestUserInput" => {
                if self.text {
                    self.client.respond(&id, json!({ "answers": {} }));
                    return Ok(());
                }
                let questions = user_questions(params);
                let request_id = request_key(&id);
                self.pending.insert(request_id.clone(), Pending::Questions { rpc_id: id });
                return self
                    .emit(AgentEvent::InputRequested {
                        request_id,
                        request: InputRequest::Questions { questions },
                    })
                    .await;
            }
            "item/tool/call" => {
                // No dynamic tools are registered.
                self.client.respond(&id, json!({ "contentItems": [], "success": false }));
                return Ok(());
            }
            _ => {
                self.client.respond_error(&id, "Outcode doesn't handle this request.");
                return Ok(());
            }
        };
        if self.text {
            // A text run asks nothing.
            self.client.respond(&id, approval_response(&kind, ApprovalDecision::Deny));
            return Ok(());
        }
        if free {
            self.client.respond(&id, approval_response(&kind, ApprovalDecision::Allow));
            return Ok(());
        }
        let request_id = request_key(&id);
        self.pending
            .insert(request_id.clone(), Pending::Approval { rpc_id: id, kind });
        self.emit(AgentEvent::InputRequested { request_id, request }).await
    }

    /// Nobody listens any more: the server goes down in the background.
    fn abandon(self) {
        let Session { client, mut child, .. } = self;
        drop(client);
        tokio::spawn(async move { rpc::retire(&mut child).await });
    }

    /// The server exited or the run closed. A turn still in flight ends here.
    async fn finish(self) {
        let in_flight = self.turn.is_some();
        let Session {
            client,
            mut child,
            stderr,
            events,
            closing,
            ..
        } = self;
        drop(client); // Closes stdin: the server exits.
        let status = rpc::retire(&mut child).await;
        if !in_flight {
            return;
        }
        let status = if closing {
            DoneStatus::Interrupted
        } else {
            let message = stderr.under(format!(
                "Codex exited unexpectedly (exit code {}).",
                cli::exit_code(status)
            ));
            let _ = events.send(AgentEvent::Error { message }).await;
            DoneStatus::Errored
        };
        let _ = events.send(AgentEvent::Done { status }).await;
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

fn approval_response(kind: &ApprovalKind, decision: ApprovalDecision) -> Value {
    let yes = decision != ApprovalDecision::Deny;
    match kind {
        ApprovalKind::Decision => json!({
            "decision": match decision {
                ApprovalDecision::Allow => "accept",
                ApprovalDecision::AllowSession => "acceptForSession",
                ApprovalDecision::Deny => "decline",
            }
        }),
        ApprovalKind::Permissions(asked) => {
            let mut granted = Map::new();
            if yes {
                for key in ["network", "fileSystem"] {
                    if let Some(value) = asked.get(key).filter(|v| !v.is_null()) {
                        granted.insert(key.into(), value.clone());
                    }
                }
            }
            let scope = if decision == ApprovalDecision::AllowSession { "session" } else { "turn" };
            json!({ "permissions": granted, "scope": scope })
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

/// `item/tool/requestUserInput`'s questions.
fn user_questions(params: &Value) -> Vec<UserInputQuestion> {
    let list = |value: &Value| value.as_array().map(Vec::as_slice).unwrap_or_default().to_vec();
    list(&params["questions"])
        .iter()
        .enumerate()
        .map(|(i, q)| UserInputQuestion {
            id: q["id"].as_str().map_or_else(|| format!("q{i}"), str::to_owned),
            header: q["header"]
                .as_str()
                .map(str::trim)
                .filter(|h| !h.is_empty())
                .unwrap_or("Question")
                .to_owned(),
            question: q["question"].as_str().unwrap_or_default().to_owned(),
            options: list(&q["options"])
                .iter()
                .filter_map(|o| {
                    Some(UserInputOption {
                        label: o["label"].as_str()?.to_owned(),
                        description: o["description"]
                            .as_str()
                            .map(str::trim)
                            .filter(|d| !d.is_empty())
                            .map(str::to_owned),
                    })
                })
                .collect(),
            multi_select: false,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use outcode_proto::ChatConfig;

    use super::*;

    fn request(access: AccessMode) -> RunRequest {
        RunRequest {
            prompt: "p".into(),
            cwd: "/w".into(),
            config: ChatConfig {
                model: Some("m".into()),
                access,
                ..ChatConfig::default()
            },
            ..RunRequest::default()
        }
    }

    #[test]
    fn mcp_server_rides_as_dotted_overrides_but_not_on_text_runs() {
        let mut r = request(AccessMode::Supervised);
        r.mcp = Some(McpServer {
            name: "outcode".into(),
            command: "/opt/outcode".into(),
            args: vec!["mcp".into()],
            env: [("OUTCODE_CHAT_ID".to_owned(), "c1".to_owned())].into(),
        });
        let p = thread_params(&r, Some("/w"), false);
        assert_eq!(p["config"]["mcp_servers.outcode.command"], "/opt/outcode");
        assert_eq!(p["config"]["mcp_servers.outcode.args"], json!(["mcp"]));
        assert_eq!(p["config"]["mcp_servers.outcode.env"], json!({"OUTCODE_CHAT_ID": "c1"}));
        assert_eq!(p["config"]["mcp_servers.outcode.default_tools_approval_mode"], "approve");
        assert_eq!(p["config"]["mcp_servers.outcode.tool_timeout_sec"], 3900);
        assert!(thread_params(&r, None, true).get("config").is_none());
    }

    #[test]
    fn access_maps_onto_policy_and_sandbox() {
        let p = thread_params(&request(AccessMode::FullAccess), None, false);
        assert_eq!(p["approvalPolicy"], "never");
        assert_eq!(p["sandbox"], "danger-full-access");
        assert_eq!(p["model"], "m");
        let p = thread_params(&request(AccessMode::Supervised), None, false);
        assert_eq!(p["approvalPolicy"], "untrusted");
        assert!(p.get("sandbox").is_none(), "the user's own sandbox");
        let p = thread_params(&request(AccessMode::Supervised), None, true);
        assert_eq!(p["approvalPolicy"], "never");
        assert_eq!(p["sandbox"], "read-only");
        assert_eq!(p["ephemeral"], true);
    }

    #[test]
    fn answers_and_grants() {
        use ApprovalDecision::*;
        assert_eq!(approval_response(&ApprovalKind::Decision, Deny), json!({ "decision": "decline" }));
        assert_eq!(
            approval_response(&ApprovalKind::Decision, AllowSession),
            json!({ "decision": "acceptForSession" })
        );
        let asked = json!({ "network": { "enabled": true }, "fileSystem": null });
        assert_eq!(
            approval_response(&ApprovalKind::Permissions(asked.clone()), Allow),
            json!({ "permissions": { "network": { "enabled": true } }, "scope": "turn" })
        );
        assert_eq!(
            approval_response(&ApprovalKind::Permissions(asked), Deny),
            json!({ "permissions": {}, "scope": "turn" })
        );
        let q = user_questions(&json!({ "questions": [
            { "id": "a", "header": "", "question": "Which?", "isOther": false, "isSecret": false,
              "options": [{ "label": "X", "description": "" }, { "label": "Y", "description": "why" }] },
            { "id": "b", "header": "H", "question": "Free?", "options": null }
        ]}));
        assert_eq!(q[0].header, "Question");
        assert_eq!(q[0].options[0].description, None);
        assert_eq!(q[0].options[1].description.as_deref(), Some("why"));
        assert!(q[1].options.is_empty());
        assert_eq!(request_key(&json!(3)), "codex-3");
    }
}
