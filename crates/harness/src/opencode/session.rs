//! One run: an `opencode serve` holding one session, a turn at a time.

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use hive_proto::{
    AccessMode, AgentEvent, CommandKind, DoneStatus, HarnessId, RunRequest, SlashCommand,
    UserInputAnswer, UserInputQuestion,
};
use serde_json::{json, Map, Value};
use tokio::sync::mpsc;
use tokio::time::Instant;

use super::models::{self, Models};
use super::normalize::{error_message, Normalizer};
use super::server::{Api, Bus, Server};
use crate::approval;
use crate::attachments;
use crate::claude::sleep_until;
use crate::{RunCommand, RunHandle};

/// How long an interrupted turn may take to report its end.
const INTERRUPT_SETTLE: Duration = Duration::from_secs(5);
/// How long a sent prompt may go without its execution starting. OpenCode
/// reports it within milliseconds of taking the prompt.
const STALL: Duration = Duration::from_secs(90);
/// How long the event bus may take to connect.
const BUS_CONNECT: Duration = Duration::from_secs(15);
/// How often the server process is checked on.
const SERVER_POLL: Duration = Duration::from_millis(500);
/// The turn that follows an approved plan.
const IMPLEMENT_PROMPT: &str = "Implement the plan.";
const STALL_HINT: &str = "OpenCode took the prompt but never started on it. The model's provider may be unreachable or rejecting requests; check `opencode auth list` and the model.";

/// OpenCode's default agent, and its read-only planning one.
const BUILD_AGENT: &str = "build";
const PLAN_AGENT: &str = "plan";

pub(super) struct Launch {
    pub exe: PathBuf,
    pub request: RunRequest,
    /// The harness's model list when the run started (may be empty).
    pub models: Models,
    /// Commands and skills by folder, refreshed here.
    pub commands: Arc<Mutex<HashMap<String, Vec<SlashCommand>>>>,
}

pub(super) fn run(launch: Launch) -> crate::Run {
    let (events_tx, events) = mpsc::channel(256);
    let (handle, commands) = RunHandle::new();
    tokio::spawn(async move {
        let failed = |message: String| AgentEvent::Done {
            status: DoneStatus::Errored,
            error: Some(message),
            session_id: launch.request.resume.clone(),
        };
        match Session::open(&launch, events_tx.clone()).await {
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
                let _ = events_tx.send(failed(message)).await;
            }
        }
    });
    crate::Run { events, handle }
}

struct Prompt {
    text: String,
    files: Vec<String>,
}

/// The turn in flight, from our prompt until its execution ends.
struct Turn {
    /// Runs the plan agent: a plan it ends with is offered for implementing.
    plan: bool,
    /// Its execution has been seen starting.
    started: bool,
    /// Waiting on whether to implement its plan; nothing runs meanwhile.
    awaiting_plan: bool,
}

/// What the user is being asked, keyed by the request id the UI answers.
enum Pending {
    Permission {
        session: String,
        id: String,
        question: UserInputQuestion,
    },
    Form {
        session: String,
        id: String,
        fields: Vec<Field>,
    },
    Plan {
        question: UserInputQuestion,
    },
}

/// A form field asked as a question (its key is the question's id).
struct Field {
    key: String,
    kind: FieldKind,
}

#[derive(Clone, Copy, PartialEq)]
enum FieldKind {
    Text,
    Multi,
    Bool,
    Number,
}

enum Reply {
    /// The prompt (or command) wasn't taken.
    PromptFailed(String),
    Commands(Vec<SlashCommand>),
}

struct Session {
    server: Server,
    api: Api,
    bus: mpsc::Receiver<Bus>,
    events: mpsc::Sender<AgentEvent>,
    normalizer: Normalizer,
    session_id: String,
    cwd: String,
    access: AccessMode,
    plan: bool,
    /// The agent the session runs now.
    agent: String,
    /// The model to name before the server reports one.
    model: String,
    /// The folder's commands and skills (`$name` skills ride the prompt).
    commands: Vec<SlashCommand>,
    commands_cache: Arc<Mutex<HashMap<String, Vec<SlashCommand>>>>,
    /// Told with the first turn: the old session couldn't be resumed.
    resume_note: Option<String>,
    turn: Option<Turn>,
    queue: VecDeque<Prompt>,
    pending: HashMap<String, Pending>,
    /// Turns ended here before the server said so; their late ends are dropped.
    settled: u32,
    interrupt_deadline: Option<Instant>,
    stall_deadline: Option<Instant>,
    replies: mpsc::UnboundedSender<Reply>,
    replies_rx: mpsc::UnboundedReceiver<Reply>,
    closing: bool,
    plans: u64,
}

struct Gone;

/// What a run may do without asking. `auto_approve` means full access.
pub(super) fn access(request: &RunRequest) -> AccessMode {
    if request.auto_approve {
        AccessMode::FullAccess
    } else {
        request.access
    }
}

/// The session's permission rules for `access`. OpenCode's agents allow
/// almost everything; a restricted mode adds `ask` rules, which the session
/// applies after the agent's own. Supervised asks before edits too, except
/// in plan mode, where the plan agent's own denial must hold (a session
/// rule would override it).
pub(super) fn permission_rules(access: AccessMode, plan_agent: bool) -> Value {
    if access.is_full_access() {
        return json!([]);
    }
    let mut asked = vec!["shell", "bash", "execute", "webfetch", "websearch"];
    if access == AccessMode::Supervised && !plan_agent {
        asked.push("edit");
    }
    Value::Array(
        asked
            .into_iter()
            .map(|action| json!({ "action": action, "resource": "*", "effect": "ask" }))
            .collect(),
    )
}

/// `{ id, providerID, variant }` for `/api/session` and `.../model`.
pub(super) fn model_ref(request: &RunRequest, models: &Models) -> Option<Value> {
    let id = request.model.as_deref()?;
    let (provider, model) = models::split(id)?;
    let mut value = json!({ "id": model, "providerID": provider });
    let variant = models
        .variants
        .get(id)
        .and_then(|v| models::variant(v, request.reasoning));
    if let Some(variant) = variant {
        value["variant"] = json!(variant);
    }
    Some(value)
}

impl Session {
    async fn open(launch: &Launch, events: mpsc::Sender<AgentEvent>) -> Result<Self, String> {
        let request = &launch.request;
        let server = Server::start(&launch.exe, &request.cwd, request.mcp.as_ref()).await?;
        let api = server.api.clone();
        let mut bus = api.subscribe();
        // Wait for the stream to be live, so nothing after this is missed.
        match tokio::time::timeout(BUS_CONNECT, bus.recv()).await {
            Ok(Some(Bus::Frame(_))) => {}
            Ok(Some(Bus::Lost(e))) => {
                server.shutdown().await;
                return Err(e);
            }
            _ => {
                server.shutdown().await;
                return Err("OpenCode's event stream didn't connect.".into());
            }
        }
        let access = access(request);
        let plan = request.plan;
        // Before the harness has listed them (a first run), from this server.
        let models = if launch.models.models.is_empty() {
            super::fetch_models(&api, 1).await.unwrap_or_default()
        } else {
            launch.models.clone()
        };
        let model = model_ref(request, &models);
        let mut resume_note = None;
        let mut agent = BUILD_AGENT.to_owned();

        let resumed = match &request.resume {
            Some(id) => match api.get(&format!("/api/session/{id}")).await {
                Ok(info) => {
                    agent = info["agent"].as_str().unwrap_or(BUILD_AGENT).to_owned();
                    Some(id.clone())
                }
                Err(e) => {
                    resume_note = Some(format!(
                        "Couldn't resume the earlier OpenCode session ({e}); this continues in a new one."
                    ));
                    None
                }
            },
            None => None,
        };
        let opened = match resumed {
            Some(id) => {
                // The run's settings, which may have changed since.
                let result = async {
                    let rules = permission_rules(access, agent == PLAN_AGENT);
                    api.patch(&format!("/api/session/{id}"), &json!({ "permissions": rules }))
                        .await?;
                    if let Some(model) = &model {
                        api.post(&format!("/api/session/{id}/model"), &json!({ "model": model }))
                            .await?;
                    }
                    Ok::<_, String>(id)
                }
                .await;
                result
            }
            None => {
                let mut body = json!({
                    "location": { "directory": request.cwd },
                    "permissions": permission_rules(access, plan),
                });
                if let Some(model) = &model {
                    body["model"] = model.clone();
                }
                if plan {
                    body["agent"] = json!(PLAN_AGENT);
                    agent = PLAN_AGENT.to_owned();
                }
                api.post("/api/session", &body).await.and_then(|created| {
                    created["id"]
                        .as_str()
                        .map(str::to_owned)
                        .ok_or_else(|| "OpenCode created a session without an id.".to_owned())
                })
            }
        };
        let session_id = match opened {
            Ok(id) => id,
            Err(e) => {
                let stderr = server.stderr();
                server.shutdown().await;
                return Err(if stderr.is_empty() {
                    format!("OpenCode couldn't start a session: {e}")
                } else {
                    format!("OpenCode couldn't start a session: {e}\n{stderr}")
                });
            }
        };

        let (replies, replies_rx) = mpsc::unbounded_channel();
        let commands = launch
            .commands
            .lock()
            .unwrap()
            .get(&request.cwd)
            .cloned()
            .unwrap_or_default();
        {
            let api = api.clone();
            let replies = replies.clone();
            tokio::spawn(async move {
                if let Ok(commands) = list_commands(&api).await {
                    let _ = replies.send(Reply::Commands(commands));
                }
            });
        }
        Ok(Self {
            normalizer: Normalizer::new(session_id.clone(), models.windows.clone()),
            server,
            api,
            bus,
            events,
            session_id,
            cwd: request.cwd.clone(),
            access,
            plan,
            agent,
            model: request
                .model
                .clone()
                .or_else(|| models.default.clone())
                .unwrap_or_default(),
            commands,
            commands_cache: Arc::clone(&launch.commands),
            resume_note,
            turn: None,
            queue: VecDeque::new(),
            pending: HashMap::new(),
            settled: 0,
            interrupt_deadline: None,
            stall_deadline: None,
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
        if !self.commands.is_empty() {
            let _ = self.report_commands().await;
        }
        if self
            .begin(Prompt { text: prompt, files }, true)
            .await
            .is_err()
        {
            self.server.shutdown().await;
            return;
        }
        let mut commands_open = true;
        let mut poll = tokio::time::interval(SERVER_POLL);
        let mut lost = None;
        loop {
            let outcome = tokio::select! {
                message = self.bus.recv() => match message {
                    Some(Bus::Frame(frame)) => self.on_frame(&frame).await,
                    Some(Bus::Lost(e)) => { lost = Some(e); break; }
                    None => { lost = Some("OpenCode's event stream ended.".into()); break; }
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
                _ = sleep_until(self.stall_deadline) => {
                    self.stall_deadline = None;
                    self.interrupt_quietly();
                    self.end_turn(DoneStatus::Errored, Some(STALL_HINT.into())).await
                }
                _ = poll.tick() => {
                    if self.server.exited().is_some() {
                        break;
                    }
                    Ok(())
                }
            };
            if outcome.is_err() {
                self.server.shutdown().await;
                return;
            }
            if self.closing && self.turn.is_none() {
                break;
            }
        }
        self.finish(lost).await;
    }

    /// Starts a turn: the user's (`user`), or the one implementing an
    /// approved plan.
    async fn begin(&mut self, prompt: Prompt, user: bool) -> Result<(), Gone> {
        if user {
            let model = self.normalizer.model.clone().unwrap_or(self.model.clone());
            self.emit(AgentEvent::SessionStarted {
                harness: HarnessId::Opencode,
                model,
                cwd: self.cwd.clone(),
                session_id: self.session_id.clone(),
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
            plan,
            started: false,
            awaiting_plan: false,
        });
        if let Err(e) = self.use_agent(if plan { PLAN_AGENT } else { BUILD_AGENT }).await {
            // Ends the turn from the loop (`end_turn` here would recurse).
            let _ = self.replies.send(Reply::PromptFailed(e));
            return Ok(());
        }
        self.stall_deadline = Some(Instant::now() + STALL);
        let api = self.api.clone();
        let session = self.session_id.clone();
        let replies = self.replies.clone();
        let text = prompt.text.trim();
        if prompt.files.is_empty() && text == "/compact" {
            self.normalizer.compact_turn = true;
            tokio::spawn(async move {
                if let Err(e) = api.post(&format!("/api/session/{session}/compact"), &json!({})).await {
                    let _ = replies.send(Reply::PromptFailed(e));
                }
            });
            return Ok(());
        }
        if let Some((name, args)) = self.command(text) {
            let body = json!({ "name": name, "text": args });
            tokio::spawn(async move {
                // Answers once the command's turn is over; the bus has it all.
                if let Err(e) = api
                    .post_unbounded(&format!("/api/session/{session}/command"), &body)
                    .await
                {
                    let _ = replies.send(Reply::PromptFailed(e));
                }
            });
            return Ok(());
        }
        let body = self.prompt_body(&prompt).await;
        tokio::spawn(async move {
            if let Err(e) = api.post(&format!("/api/session/{session}/prompt"), &body).await {
                let _ = replies.send(Reply::PromptFailed(e));
            }
        });
        Ok(())
    }

    /// A leading `/name args` naming one of the folder's commands.
    fn command(&self, text: &str) -> Option<(String, String)> {
        let rest = text.strip_prefix('/')?;
        let (name, args) = rest.split_once(char::is_whitespace).unwrap_or((rest, ""));
        self.commands
            .iter()
            .any(|c| c.kind == CommandKind::Command && c.name == name)
            .then(|| (name.to_owned(), args.trim().to_owned()))
    }

    async fn prompt_body(&self, prompt: &Prompt) -> Value {
        let text = attachments::prompt_with_attachments(&prompt.text, &prompt.files);
        let files: Vec<Value> = attachments::image_paths(&prompt.files)
            .await
            .iter()
            .map(|path| json!({ "uri": file_url(path), "name": file_name(path) }))
            .collect();
        let skills: Vec<Value> = self
            .commands
            .iter()
            .filter(|c| c.kind == CommandKind::Skill && mentions(&prompt.text, &c.name))
            .map(|c| json!({ "id": c.name }))
            .collect();
        let mut body = json!({ "text": text });
        if !files.is_empty() {
            body["files"] = Value::Array(files);
        }
        if !skills.is_empty() {
            body["skills"] = Value::Array(skills);
        }
        body
    }

    /// Switches the session to `agent`, with the permission rules it runs
    /// under (supervised asks before edits only outside the plan agent).
    async fn use_agent(&mut self, agent: &str) -> Result<(), String> {
        if self.agent == agent {
            return Ok(());
        }
        let session = &self.session_id;
        self.api
            .post(&format!("/api/session/{session}/agent"), &json!({ "agent": agent }))
            .await?;
        if self.access == AccessMode::Supervised {
            let rules = permission_rules(self.access, agent == PLAN_AGENT);
            self.api
                .patch(&format!("/api/session/{session}"), &json!({ "permissions": rules }))
                .await?;
        }
        self.agent = agent.to_owned();
        Ok(())
    }

    async fn on_reply(&mut self, reply: Reply) -> Result<(), Gone> {
        match reply {
            Reply::PromptFailed(message) => {
                let waiting = self
                    .turn
                    .as_ref()
                    .is_some_and(|t| !t.started && !t.awaiting_plan);
                if waiting {
                    self.end_turn(DoneStatus::Errored, Some(message)).await
                } else {
                    // A command that failed after its turn began.
                    self.emit(AgentEvent::Error { message }).await
                }
            }
            Reply::Commands(commands) => {
                self.commands_cache
                    .lock()
                    .unwrap()
                    .insert(self.cwd.clone(), commands.clone());
                self.commands = commands;
                self.report_commands().await
            }
        }
    }

    async fn report_commands(&mut self) -> Result<(), Gone> {
        let commands = super::with_builtins(&self.commands);
        self.emit(AgentEvent::AvailableCommands { commands }).await
    }

    async fn on_frame(&mut self, frame: &Value) -> Result<(), Gone> {
        let kind = frame["type"].as_str().unwrap_or_default();
        let data = &frame["data"];
        let root = data["sessionID"].as_str() == Some(self.session_id.as_str());
        match kind {
            "permission.asked" => self.on_permission(data).await,
            "permission.replied" => {
                let id = data["id"].as_str().or(data["requestID"].as_str());
                self.resolved(id).await
            }
            "form.created" => self.on_form(&data["form"]).await,
            "form.replied" | "form.cancelled" | "form.canceled" | "form.settled" => {
                let id = data["id"].as_str().or(data["formID"].as_str()).or(data["form"]["id"].as_str());
                self.resolved(id).await
            }
            "session.execution.started" if root => {
                if let Some(turn) = &mut self.turn {
                    turn.started = true;
                    self.stall_deadline = None;
                }
                Ok(())
            }
            "session.execution.succeeded" if root => self.on_end(DoneStatus::Completed, None).await,
            "session.execution.interrupted" if root => self.on_end(DoneStatus::Interrupted, None).await,
            "session.execution.failed" if root => {
                let message = error_message(&data["error"]);
                // Already shown when the step failed with it.
                let shown = self.normalizer.last_error.as_deref() == Some(message.as_str());
                let error = (!shown).then_some(message);
                self.on_end(DoneStatus::Errored, error).await
            }
            _ => {
                for event in self.normalizer.frame(frame) {
                    self.emit(event).await?;
                }
                Ok(())
            }
        }
    }

    /// The root's execution ended.
    async fn on_end(&mut self, status: DoneStatus, error: Option<String>) -> Result<(), Gone> {
        let Some(turn) = &self.turn else {
            return Ok(());
        };
        if turn.awaiting_plan {
            return Ok(());
        }
        if !turn.started && self.settled > 0 {
            // The late end of a turn already settled here.
            self.settled -= 1;
            return Ok(());
        }
        let planned = status == DoneStatus::Completed
            && turn.plan
            && self.normalizer.text_seen
            && !self.closing;
        if !planned {
            return self.end_turn(status, error).await;
        }
        if self.access.is_full_access() {
            return self.implement().await;
        }
        self.plans += 1;
        let request_id = format!("opencode-plan-{}", self.plans);
        let question = approval::question(
            "Approve plan",
            "OpenCode wants to start implementing its plan. Allow it?",
        );
        if let Some(turn) = &mut self.turn {
            turn.awaiting_plan = true;
        }
        self.interrupt_deadline = None;
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
        self.stall_deadline = None;
        let open: Vec<String> = self.pending.drain().map(|(id, _)| id).collect();
        for request_id in open {
            self.emit(AgentEvent::InputResolved { request_id }).await?;
        }
        self.emit(AgentEvent::Done {
            status,
            error,
            session_id: Some(self.session_id.clone()),
        })
        .await?;
        if !self.closing {
            if let Some(next) = self.queue.pop_front() {
                self.begin(next, true).await?;
            }
        }
        Ok(())
    }

    fn interrupt_quietly(&self) {
        let api = self.api.clone();
        let path = format!("/api/session/{}/interrupt", self.session_id);
        tokio::spawn(async move {
            let _ = api.post(&path, &Value::Null).await;
        });
    }

    /// The interrupted turn never reported; end it here.
    async fn settle_interrupt(&mut self) -> Result<(), Gone> {
        if self.turn.as_ref().is_some_and(|t| t.started) {
            self.settled += 1;
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
                    self.interrupt_quietly();
                    self.interrupt_deadline = Some(Instant::now() + INTERRUPT_SETTLE);
                }
                Ok(())
            }
            RunCommand::StopTask { .. } => Ok(()),
            RunCommand::TaskOutput { reply, .. } => {
                let _ = reply.send(Err("OpenCode doesn't share background task output.".into()));
                Ok(())
            }
            RunCommand::Close => {
                self.closing = true;
                self.queue.clear();
                Ok(())
            }
        }
    }

    async fn on_permission(&mut self, data: &Value) -> Result<(), Gone> {
        let (Some(id), Some(session)) = (data["id"].as_str(), data["sessionID"].as_str()) else {
            return Ok(());
        };
        if !self.normalizer.owns(session) || self.pending.contains_key(id) {
            return Ok(());
        }
        let action = data["action"].as_str().unwrap_or_default();
        let edit = matches!(action, "edit" | "write" | "patch" | "apply_patch" | "multiedit");
        let kind = if edit {
            approval::Action::Edit
        } else {
            approval::Action::Other
        };
        if approval::allowed_without_asking(self.access, kind) {
            self.reply_permission(session, id, true);
            return Ok(());
        }
        let question = permission_question(data, &self.cwd);
        self.pending.insert(
            id.to_owned(),
            Pending::Permission {
                session: session.to_owned(),
                id: id.to_owned(),
                question: question.clone(),
            },
        );
        self.emit(AgentEvent::InputRequested {
            request_id: id.to_owned(),
            questions: vec![question],
        })
        .await
    }

    fn reply_permission(&self, session: &str, id: &str, yes: bool) {
        let api = self.api.clone();
        let path = format!("/api/session/{session}/permission/{id}/reply");
        // A bare reject stops the whole turn; with a message the agent is
        // told and carries on, as with the other harnesses.
        let body = if yes {
            json!({ "decision": "once" })
        } else {
            json!({ "decision": "reject", "message": "The user declined this. Continue without it, or ask how to proceed." })
        };
        tokio::spawn(async move {
            let _ = api.post(&path, &body).await;
        });
    }

    async fn on_form(&mut self, form: &Value) -> Result<(), Gone> {
        let (Some(id), Some(session)) = (form["id"].as_str(), form["sessionID"].as_str()) else {
            return Ok(());
        };
        if !self.normalizer.owns(session) || self.pending.contains_key(id) {
            return Ok(());
        }
        let (fields, questions) = form_questions(form);
        if questions.is_empty() {
            // Nothing Hive can show; left open, it would hold the turn.
            let api = self.api.clone();
            let path = format!("/api/session/{session}/form/{id}");
            tokio::spawn(async move {
                let _ = api.delete(&path).await;
            });
            return Ok(());
        }
        self.pending.insert(
            id.to_owned(),
            Pending::Form {
                session: session.to_owned(),
                id: id.to_owned(),
                fields,
            },
        );
        self.emit(AgentEvent::InputRequested {
            request_id: id.to_owned(),
            questions,
        })
        .await
    }

    /// The server settled a request (answered elsewhere, or by us).
    async fn resolved(&mut self, id: Option<&str>) -> Result<(), Gone> {
        let Some(id) = id else {
            return Ok(());
        };
        if self.pending.remove(id).is_some() {
            self.emit(AgentEvent::InputResolved {
                request_id: id.to_owned(),
            })
            .await?;
        }
        Ok(())
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
            Pending::Permission {
                session,
                id,
                question,
            } => {
                self.reply_permission(&session, &id, approval::approved(&question, &answers));
                Ok(())
            }
            Pending::Form {
                session,
                id,
                fields,
            } => {
                let api = self.api.clone();
                let path = format!("/api/session/{session}/form/{id}/reply");
                let body = json!({ "answer": form_answer(&fields, &answers) });
                tokio::spawn(async move {
                    let _ = api.post(&path, &body).await;
                });
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

    /// The server exited, the bus was lost, or the run closed. A turn still
    /// in flight ends here.
    async fn finish(mut self, lost: Option<String>) {
        let in_flight = self.turn.is_some();
        let exited = self.server.exited();
        let stderr = self.server.stderr();
        let Session {
            server,
            events,
            session_id,
            closing,
            ..
        } = self;
        server.shutdown().await;
        if !in_flight {
            return;
        }
        let (status, error) = if closing && lost.is_none() && exited.is_none() {
            (DoneStatus::Interrupted, None)
        } else {
            let mut message = match (lost, exited) {
                (_, Some(status)) => format!(
                    "opencode exited unexpectedly (exit code {}).",
                    status.code().map_or("unknown".to_owned(), |c| c.to_string())
                ),
                (Some(lost), None) => lost,
                (None, None) => "OpenCode stopped answering.".into(),
            };
            if !stderr.is_empty() {
                message.push('\n');
                message.push_str(&stderr);
            }
            (DoneStatus::Errored, Some(message))
        };
        let _ = events
            .send(AgentEvent::Done {
                status,
                error,
                session_id: Some(session_id),
            })
            .await;
    }

    async fn emit(&self, event: AgentEvent) -> Result<(), Gone> {
        self.events.send(event).await.map_err(|_| Gone)
    }
}

/// The folder's commands (`/api/command`) and skills (`/api/skill`). The
/// first listing for a new folder can come back empty while it loads, so an
/// empty one is asked again.
pub(super) async fn list_commands(api: &Api) -> Result<Vec<SlashCommand>, String> {
    let mut commands = Vec::new();
    for attempt in 0..2 {
        if attempt > 0 {
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        let (listed, skills) = tokio::join!(api.get("/api/command"), api.get("/api/skill"));
        commands.clear();
        for c in listed?.as_array().into_iter().flatten() {
            let Some(name) = c["name"].as_str() else {
                continue;
            };
            commands.push(SlashCommand {
                name: name.to_owned(),
                description: c["description"].as_str().unwrap_or_default().to_owned(),
                input_hint: None,
                kind: CommandKind::Command,
            });
        }
        for s in skills.unwrap_or_default().as_array().into_iter().flatten() {
            let Some(id) = s["id"].as_str() else {
                continue;
            };
            commands.push(SlashCommand {
                name: id.to_owned(),
                description: s["description"].as_str().unwrap_or_default().to_owned(),
                input_hint: None,
                kind: CommandKind::Skill,
            });
        }
        if !commands.is_empty() {
            break;
        }
    }
    Ok(commands)
}

/// Whether `text` mentions `$name` as a whole word.
fn mentions(text: &str, name: &str) -> bool {
    let needle = format!("${name}");
    text.match_indices(&needle).any(|(at, _)| {
        let end = at + needle.len();
        text[end..]
            .chars()
            .next()
            .is_none_or(|c| !(c.is_alphanumeric() || c == '-' || c == '_'))
    })
}

/// `permission.asked` as a yes/no question.
fn permission_question(data: &Value, cwd: &str) -> UserInputQuestion {
    const AGENT: &str = "OpenCode";
    let action = data["action"].as_str().unwrap_or_default();
    let resources: Vec<&str> = data["resources"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect();
    let relative = |path: &str| -> String {
        std::path::Path::new(path)
            .strip_prefix(cwd)
            .ok()
            .and_then(|p| p.to_str())
            .filter(|p| !p.is_empty())
            .unwrap_or(path)
            .to_owned()
    };
    match action {
        "shell" | "bash" => {
            let command = data["metadata"]["command"]
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| resources.join(" && "));
            approval::command(AGENT, &command)
        }
        "edit" | "write" | "patch" | "apply_patch" | "multiedit" => {
            let files: Vec<String> = data["metadata"]["files"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|f| f["file"].as_str())
                .map(relative)
                .collect();
            let paths: Vec<String> = if files.is_empty() {
                resources.iter().map(|r| relative(r)).collect()
            } else {
                files
            };
            let paths: Vec<&str> = paths.iter().map(String::as_str).collect();
            approval::edit(AGENT, &paths)
        }
        "external_directory" => approval::question(
            "Approve access",
            format!(
                "{AGENT} wants to access {} outside the project. Allow it?",
                resources.join(", ")
            ),
        ),
        "" => approval::tool(AGENT, "a tool", Some(&resources.join(", "))),
        other => approval::tool(AGENT, other, Some(&resources.join(", "))),
    }
}

/// A form's fields as questions, each with the field key as its id. A
/// field Hive can't ask (a link) is left out.
fn form_questions(form: &Value) -> (Vec<Field>, Vec<UserInputQuestion>) {
    let mut fields = Vec::new();
    let mut questions = Vec::new();
    let title = form["title"].as_str().filter(|t| !t.is_empty());
    for field in form["fields"].as_array().into_iter().flatten() {
        let Some(key) = field["key"].as_str() else {
            continue;
        };
        if field["hidden"].as_bool() == Some(true) {
            continue;
        }
        let options: Vec<String> = field["options"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|o| o["value"].as_str().or(o["label"].as_str()))
            .map(str::to_owned)
            .collect();
        let (kind, options) = match field["type"].as_str() {
            Some("string") | None => (FieldKind::Text, options),
            Some("multiselect") => (FieldKind::Multi, options),
            Some("boolean") => (
                FieldKind::Bool,
                vec![approval::ALLOW.to_owned(), approval::DENY.to_owned()],
            ),
            Some("number" | "integer") => (FieldKind::Number, Vec::new()),
            _ => continue,
        };
        let header = field["title"].as_str().filter(|t| !t.is_empty());
        let question = field["description"]
            .as_str()
            .filter(|d| !d.trim().is_empty())
            .or(header)
            .unwrap_or(key);
        questions.push(UserInputQuestion {
            id: key.to_owned(),
            header: header.or(title).unwrap_or("Question").to_owned(),
            question: question.to_owned(),
            options,
            multi_select: kind == FieldKind::Multi,
        });
        fields.push(Field {
            key: key.to_owned(),
            kind,
        });
    }
    (fields, questions)
}

fn form_answer(fields: &[Field], answers: &[UserInputAnswer]) -> Value {
    let mut out = Map::new();
    for field in fields {
        let labels = answers
            .iter()
            .find(|a| a.question_id == field.key)
            .map(|a| a.labels.clone())
            .unwrap_or_default();
        let first = labels.first().cloned().unwrap_or_default();
        let value = match field.kind {
            FieldKind::Text => json!(first),
            FieldKind::Multi => json!(labels),
            FieldKind::Bool => json!(first.eq_ignore_ascii_case(approval::ALLOW)),
            FieldKind::Number => first
                .trim()
                .parse::<f64>()
                .map(|n| json!(n))
                .unwrap_or(json!(first)),
        };
        out.insert(field.key.clone(), value);
    }
    Value::Object(out)
}

fn file_name(path: &str) -> String {
    std::path::Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// `path` as a `file:` URL: `file:///C:/…` for a drive path, every byte
/// outside the unreserved set percent-encoded.
fn file_url(path: &str) -> String {
    let encode = |text: &str| {
        let mut out = String::new();
        for b in text.bytes() {
            match b {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => {
                    out.push(b as char)
                }
                _ => out.push_str(&format!("%{b:02X}")),
            }
        }
        out
    };
    let path = path.strip_prefix(r"\\?\").unwrap_or(path);
    let bytes = path.as_bytes();
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        return format!("file:///{}:{}", &path[..1], encode(&path[2..].replace('\\', "/")));
    }
    if let Some(unc) = path.strip_prefix(r"\\") {
        return format!("file://{}", encode(&unc.replace('\\', "/")));
    }
    format!("file://{}", encode(path))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restricted_modes_add_ask_rules() {
        assert_eq!(permission_rules(AccessMode::FullAccess, false), json!([]));
        let actions = |rules: Value| -> Vec<String> {
            rules
                .as_array()
                .unwrap()
                .iter()
                .map(|r| r["action"].as_str().unwrap().to_owned())
                .collect()
        };
        let auto = actions(permission_rules(AccessMode::AutoAcceptEdits, false));
        assert!(auto.contains(&"shell".into()) && !auto.contains(&"edit".into()));
        assert!(actions(permission_rules(AccessMode::Supervised, false)).contains(&"edit".into()));
        assert!(!actions(permission_rules(AccessMode::Supervised, true)).contains(&"edit".into()));
    }

    #[test]
    fn questions_forms_round_trip() {
        let form = json!({ "id": "f", "sessionID": "S", "title": "Questions", "fields": [
            { "key": "q0", "title": "Color", "description": "Red or blue?", "type": "string",
              "options": [{ "value": "Red", "label": "Red" }, { "value": "Blue", "label": "Blue" }] },
            { "key": "q1", "description": "Which?", "type": "multiselect", "options": [{ "value": "a" }, { "value": "b" }] },
            { "key": "q2", "type": "external", "url": "https://x" },
        ]});
        let (fields, questions) = form_questions(&form);
        assert_eq!(questions.len(), 2);
        assert_eq!(questions[0].header, "Color");
        assert_eq!(questions[0].options, ["Red", "Blue"]);
        assert_eq!(questions[1].header, "Questions");
        assert!(questions[1].multi_select);
        let answers = vec![
            UserInputAnswer { question_id: "q0".into(), labels: vec!["Blue".into()] },
            UserInputAnswer { question_id: "q1".into(), labels: vec!["a".into(), "b".into()] },
        ];
        assert_eq!(form_answer(&fields, &answers), json!({ "q0": "Blue", "q1": ["a", "b"] }));
    }

    #[test]
    fn permissions_read_as_approvals() {
        let q = permission_question(
            &json!({ "action": "shell", "resources": ["echo hi"], "metadata": {} }),
            "/w",
        );
        assert_eq!(q.question, "OpenCode wants to run `echo hi`. Allow it?");
        let q = permission_question(
            &json!({ "action": "edit", "resources": ["b.txt"], "metadata": { "files": [{ "file": "/w/b.txt" }] } }),
            "/w",
        );
        assert_eq!(q.question, "OpenCode wants to modify b.txt. Allow it?");
    }

    #[test]
    fn helpers() {
        assert!(mentions("use $review now", "review"));
        assert!(!mentions("use $reviewer", "review"));
        assert_eq!(file_url(r"C:\a b\c.png"), "file:///C:/a%20b/c.png");
        assert_eq!(file_url("/tmp/x.png"), "file:///tmp/x.png");
        let mut request: RunRequest = serde_json::from_value(json!({
            "harness": "opencode", "prompt": "p", "cwd": "/w", "sandbox": "workspace-write",
            "model": "openrouter/a/b", "reasoning": "high",
        }))
        .unwrap();
        let mut models = Models::default();
        models.variants.insert("openrouter/a/b".into(), vec!["low".into(), "high".into()]);
        assert_eq!(
            model_ref(&request, &models),
            Some(json!({ "id": "a/b", "providerID": "openrouter", "variant": "high" }))
        );
        request.model = None;
        assert_eq!(model_ref(&request, &models), None);
    }
}
