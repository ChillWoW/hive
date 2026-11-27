//! One run: an `agy acp` holding one ACP session, a prompt at a time.

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use outcode_proto::{
    AccessMode, AgentEvent, ApprovalDecision, DoneStatus, InputRequest, InputResponse, McpServer, RunRequest,
    SlashCommand, UserInputOption, UserInputQuestion,
};
use serde_json::{Value, json};
use tokio::process::Child;
use tokio::sync::mpsc;
use tokio::time::Instant;

use super::acp::{self, Client, Incoming, Server};
use super::models::{closest_level, level, level_id};
use super::normalize::Normalizer;
use crate::cli::{StderrTail, sleep_until};
use crate::{Gone, Run, RunCommand, RunHandle, attachments, cli};

/// How long an interrupted turn may take to report its end before the run
/// reports it interrupted anyway.
const INTERRUPT_SETTLE: Duration = Duration::from_secs(5);
/// How long the agent gets to save its conversation after stdin closes.
const EXIT_GRACE: Duration = Duration::from_secs(10);

/// Each folder's commands and skills, as the last session there listed them.
pub(super) type CommandCache = Arc<Mutex<HashMap<String, Vec<SlashCommand>>>>;

/// What the session was started for.
pub(super) struct Launch {
    pub exe: PathBuf,
    pub request: RunRequest,
    /// A text run: text instructions, nothing allowed.
    pub text: bool,
    pub commands: CommandCache,
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

/// What waits on the user, keyed by the request id the UI answers.
enum Pending {
    /// A tool call to allow or not: answered with one of its `options`.
    Approval { rpc_id: Value, options: Vec<Value> },
    /// agy's own question, asked through the permission request: its
    /// options are the answers.
    Question { rpc_id: Value, options: Vec<Value> },
}

/// `session/prompt`'s answer for prompt `seq`.
struct Prompted {
    seq: u64,
    result: Result<Value, String>,
}

/// The ACP mode for an access mode: agy has no mode that runs everything,
/// so full access accepts edits and the rest is allowed here.
fn mode_for(access: AccessMode, plan: bool, text: bool) -> &'static str {
    if text {
        "default"
    } else if plan {
        "plan"
    } else if access == AccessMode::Supervised {
        "default"
    } else {
        "accept-edits"
    }
}

/// `session/new`'s and `session/resume`'s `mcpServers`: Outcode's own
/// server, launched over stdio.
fn mcp_servers(mcp: Option<&McpServer>) -> Value {
    let Some(mcp) = mcp else {
        return json!([]);
    };
    let env: Vec<Value> = mcp
        .env
        .iter()
        .map(|(name, value)| json!({ "name": name, "value": value }))
        .collect();
    json!([{ "name": mcp.name, "command": mcp.command, "args": mcp.args, "env": env }])
}

/// The select `config_id`'s current value and its choices, from
/// `configOptions`.
fn config_option<'a>(options: &'a Value, config_id: &str) -> Option<(&'a str, Vec<&'a str>)> {
    let option = options.as_array()?.iter().find(|o| o["id"].as_str() == Some(config_id))?;
    let values = option["options"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .flat_map(|o| match o["options"].as_array() {
            // A group of choices.
            Some(group) => group.iter().filter_map(|g| g["value"].as_str()).collect::<Vec<_>>(),
            None => o["value"].as_str().into_iter().collect(),
        })
        .collect();
    Some((option["currentValue"].as_str().unwrap_or_default(), values))
}

/// `session/set_config_option` on one session, keeping its `configOptions`
/// current: a new model brings its own thinking levels.
struct SetOption<'a> {
    client: &'a Client,
    session_id: &'a str,
}

impl SetOption<'_> {
    async fn apply(&self, options: &mut Value, config_id: &str, value: &str) -> Result<(), String> {
        let params = json!({ "sessionId": self.session_id, "configId": config_id, "value": value });
        let result = self.client.request("session/set_config_option", params).await?;
        if result["configOptions"].is_array() {
            *options = result["configOptions"].clone();
        }
        Ok(())
    }
}

struct Session {
    client: Client,
    child: Child,
    incoming: mpsc::Receiver<Incoming>,
    stderr: StderrTail,
    events: mpsc::Sender<AgentEvent>,
    normalizer: Normalizer,
    session_id: String,
    /// The folder as requested: the commands cache's key.
    folder: String,
    commands_cache: CommandCache,
    access: AccessMode,
    plan: bool,
    text: bool,
    /// The session's ACP mode now.
    mode: String,
    /// Told as the first turn starts: the old session couldn't be resumed.
    resume_note: Option<String>,
    /// The prompt in flight, by its number.
    turn: Option<u64>,
    prompts: u64,
    queue: VecDeque<Prompt>,
    pending: HashMap<String, Pending>,
    interrupt_deadline: Option<Instant>,
    replies: mpsc::UnboundedSender<Prompted>,
    replies_rx: mpsc::UnboundedReceiver<Prompted>,
    closing: bool,
    /// Text runs: the instructions ride on the session (agy 1.5's
    /// `systemPrompt.append`), else on the prompt.
    instructions_in_prompt: bool,
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
            info,
            ..
        } = server;
        let cwd = cwd.map_or_else(String::new, |c| c.to_string_lossy().into_owned());
        let mcp = mcp_servers(request.mcp.as_ref().filter(|_| !launch.text));
        let appends = info["agentCapabilities"]["_meta"]["antigravity"]["systemPrompt"]["append"].as_bool() == Some(true);

        let mut resume_note = None;
        let resumed = match request.resume.as_deref().filter(|r| !r.is_empty() && !launch.text) {
            Some(id) => {
                let params = json!({ "sessionId": id, "cwd": cwd, "mcpServers": mcp });
                match client.request("session/resume", params).await {
                    Ok(result) => Some((id.to_owned(), result)),
                    Err(e) => {
                        resume_note = Some(format!(
                            "Couldn't resume the earlier Antigravity session ({e}); this continues in a new one."
                        ));
                        None
                    }
                }
            }
            None => None,
        };
        let opened = match resumed {
            Some(resumed) => Ok(resumed),
            None => {
                let mut params = json!({ "cwd": cwd, "mcpServers": mcp });
                if launch.text && appends {
                    params["_meta"] = json!({ "antigravity": { "systemPrompt": { "append": crate::TEXT_INSTRUCTIONS } } });
                }
                client.request("session/new", params).await.and_then(|result| {
                    match result["sessionId"].as_str().filter(|s| !s.is_empty()) {
                        Some(id) => Ok((id.to_owned(), result)),
                        None => Err("no session id".to_owned()),
                    }
                })
            }
        };
        let (session_id, result) = match opened {
            Ok(opened) => opened,
            Err(e) => {
                let message = if e.contains(super::provider::SIGNED_OUT) {
                    "Antigravity isn't signed in. Sign in under Settings › Providers › Antigravity.".to_owned()
                } else {
                    stderr.under(format!("Antigravity couldn't start a session: {e}"))
                };
                drop(client);
                tokio::spawn(async move { retire(&mut child).await });
                return Err(message);
            }
        };

        // The model, then its thinking level: a model's levels are its own.
        let mut options = result["configOptions"].clone();
        let set = SetOption {
            client: &client,
            session_id: &session_id,
        };
        if let Some(model) = request.config.model.as_deref().filter(|m| !m.is_empty())
            && config_option(&options, "model").is_none_or(|(current, _)| current != model)
            && let Err(e) = set.apply(&mut options, "model", model).await
        {
            let message = format!("Antigravity couldn't switch to {model}: {e}");
            drop(client);
            tokio::spawn(async move { retire(&mut child).await });
            return Err(message);
        }
        if let Some(wanted) = request.config.reasoning
            && let Some((current, values)) = config_option(&options, "thought_level")
        {
            let mut offered: Vec<_> = values.iter().filter_map(|v| level(v)).collect();
            offered.sort();
            if let Some(fit) = closest_level(&offered, wanted).map(level_id)
                && fit != current
            {
                // A level it won't take leaves the model's default.
                let _ = set.apply(&mut options, "thought_level", fit).await;
            }
        }

        let access = if launch.text { AccessMode::Supervised } else { request.config.access };
        let plan = request.config.plan && !launch.text;
        let current_mode = result["modes"]["currentModeId"].as_str().unwrap_or("default").to_owned();
        let (replies, replies_rx) = mpsc::unbounded_channel();
        let mut session = Self {
            normalizer: Normalizer::default(),
            client,
            child,
            incoming,
            stderr,
            events,
            session_id,
            folder: request.cwd.clone(),
            commands_cache: Arc::clone(&launch.commands),
            access,
            plan,
            text: launch.text,
            mode: current_mode,
            resume_note,
            turn: None,
            prompts: 0,
            queue: VecDeque::new(),
            pending: HashMap::new(),
            interrupt_deadline: None,
            replies,
            replies_rx,
            closing: false,
            instructions_in_prompt: launch.text && !appends,
        };
        session.apply_mode().await;
        Ok(session)
    }

    /// Puts the session in the mode its access and plan mode call for.
    async fn apply_mode(&mut self) {
        let wanted = mode_for(self.access, self.plan, self.text);
        if self.mode == wanted {
            return;
        }
        let params = json!({ "sessionId": self.session_id, "modeId": wanted });
        match self.client.request("session/set_mode", params).await {
            Ok(_) => self.mode = wanted.to_owned(),
            Err(e) => eprintln!("[agy] setting mode {wanted}: {e}"),
        }
    }

    async fn run(mut self, first: Prompt, mut commands: mpsc::UnboundedReceiver<RunCommand>) {
        let started = async {
            self.report_cached_commands().await?;
            self.begin(first).await
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
                    None => break, // The agent exited.
                },
                command = commands.recv(), if commands_open => match command {
                    Some(command) => self.on_command(command).await,
                    None => {
                        commands_open = false;
                        self.close();
                        Ok(())
                    }
                },
                Some(reply) = self.replies_rx.recv() => self.on_prompted(reply).await,
                _ = sleep_until(self.interrupt_deadline) => self.end_turn(DoneStatus::Interrupted, None, None).await,
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

    /// The commands an earlier session in this folder listed, until this
    /// one lists its own.
    async fn report_cached_commands(&self) -> Result<(), Gone> {
        if self.text {
            return Ok(());
        }
        let cached = self.commands_cache.lock().unwrap().get(&self.folder).cloned();
        match cached {
            Some(commands) => self.emit(AgentEvent::AvailableCommands { commands }).await,
            None => Ok(()),
        }
    }

    /// Starts a turn on the user's prompt.
    async fn begin(&mut self, prompt: Prompt) -> Result<(), Gone> {
        let session_id = self.session_id.clone();
        self.emit(AgentEvent::SessionStarted { session_id }).await?;
        if let Some(message) = self.resume_note.take() {
            self.emit(AgentEvent::Error { message }).await?;
        }
        self.normalizer.start_turn();
        self.prompts += 1;
        let seq = self.prompts;
        self.turn = Some(seq);

        let mut text = attachments::prompt_with_attachments(&prompt.text, &prompt.files);
        if self.instructions_in_prompt {
            text = format!("{}\n\n{text}", crate::TEXT_INSTRUCTIONS);
        }
        let mut content = vec![json!({ "type": "text", "text": text })];
        for image in attachments::load_images(&prompt.files).await {
            content.push(json!({ "type": "image", "mimeType": image.media_type, "data": image.data }));
        }
        let request = self.client.request(
            "session/prompt",
            json!({ "sessionId": self.session_id, "prompt": content }),
        );
        let replies = self.replies.clone();
        tokio::spawn(async move {
            let _ = replies.send(Prompted { seq, result: request.await });
        });
        Ok(())
    }

    /// The prompt `seq` ended. One the run already gave up on is dropped.
    async fn on_prompted(&mut self, reply: Prompted) -> Result<(), Gone> {
        if self.turn != Some(reply.seq) {
            return Ok(());
        }
        let interrupted = self.interrupt_deadline.is_some();
        match reply.result {
            Ok(result) => {
                let usage = &result["usage"];
                let usage = (usage.is_object()).then(|| AgentEvent::Usage {
                    input_tokens: usage["inputTokens"].as_u64().unwrap_or(0),
                    output_tokens: usage["outputTokens"].as_u64().unwrap_or(0),
                });
                let (status, error) = match result["stopReason"].as_str().unwrap_or_default() {
                    _ if interrupted => (DoneStatus::Interrupted, None),
                    "cancelled" => (DoneStatus::Interrupted, None),
                    "refusal" => (DoneStatus::Errored, Some("The model refused to continue.".to_owned())),
                    "max_tokens" => (
                        DoneStatus::Errored,
                        Some("The reply ran past the model's output limit.".to_owned()),
                    ),
                    _ => (DoneStatus::Completed, None),
                };
                self.end_turn(status, error, usage).await
            }
            Err(_) if interrupted => self.end_turn(DoneStatus::Interrupted, None, None).await,
            Err(message) => self.end_turn(DoneStatus::Errored, Some(message), None).await,
        }
    }

    /// Reports the turn's end, drops what it left asking, and starts the
    /// next queued prompt.
    async fn end_turn(&mut self, status: DoneStatus, error: Option<String>, usage: Option<AgentEvent>) -> Result<(), Gone> {
        self.turn = None;
        self.interrupt_deadline = None;
        if let Some(message) = error {
            self.emit(AgentEvent::Error { message }).await?;
        }
        for (request_id, pending) in self.pending.drain().collect::<Vec<_>>() {
            let (Pending::Approval { rpc_id, .. } | Pending::Question { rpc_id, .. }) = &pending;
            self.client.respond(rpc_id, cancelled());
            self.emit(AgentEvent::InputResolved {
                request_id,
                response: None,
            })
            .await?;
        }
        for ended in self.normalizer.end_turn(status != DoneStatus::Completed) {
            self.emit(ended).await?;
        }
        if let Some(usage) = usage {
            self.emit(usage).await?;
        }
        self.emit(AgentEvent::Done { status }).await?;
        if !self.closing
            && let Some(next) = self.queue.pop_front()
        {
            self.begin(next).await?;
        }
        Ok(())
    }

    async fn on_notification(&mut self, method: &str, params: &Value) -> Result<(), Gone> {
        if method != "session/update" || params["sessionId"].as_str() != Some(self.session_id.as_str()) {
            return Ok(());
        }
        let between = self.turn.is_none();
        for event in self.normalizer.update(&params["update"]) {
            if let AgentEvent::AvailableCommands { commands } = &event {
                if self.text {
                    continue;
                }
                self.commands_cache
                    .lock()
                    .unwrap()
                    .insert(self.folder.clone(), commands.clone());
            } else if between && !matches!(event, AgentEvent::ContextUsage { .. }) {
                // Between turns only session state has anything to say.
                continue;
            }
            self.emit(event).await?;
        }
        Ok(())
    }

    async fn on_request(&mut self, id: Value, method: &str, params: &Value) -> Result<(), Gone> {
        if method != "session/request_permission" {
            self.client.respond_error(&id, "Outcode doesn't handle this request.");
            return Ok(());
        }
        let tool = &params["toolCall"];
        let call_id = tool["toolCallId"].as_str().unwrap_or_default().to_owned();
        let options = params["options"].as_array().cloned().unwrap_or_default();
        let request_id = request_key(&id);

        // agy's own questions share the permission request; their options
        // are the answers.
        if call_id.starts_with("interaction_") {
            if self.text || self.turn.is_none() {
                self.client.respond(&id, cancelled());
                return Ok(());
            }
            let question = UserInputQuestion {
                id: call_id,
                header: "Question".into(),
                question: tool["title"]
                    .as_str()
                    .map(str::trim)
                    .filter(|t| !t.is_empty())
                    .unwrap_or("Choose an option.")
                    .to_owned(),
                options: options
                    .iter()
                    .filter_map(|o| {
                        Some(UserInputOption {
                            label: option_name(o)?.to_owned(),
                            description: None,
                        })
                    })
                    .collect(),
                multi_select: false,
            };
            self.pending.insert(request_id.clone(), Pending::Question { rpc_id: id, options });
            return self
                .emit(AgentEvent::InputRequested {
                    request_id,
                    request: InputRequest::Questions { questions: vec![question] },
                })
                .await;
        }

        // The call as it stands, in the transcript first.
        if self.turn.is_some() {
            for event in self.normalizer.update(tool) {
                let call = match &event {
                    AgentEvent::Subagent { event, .. } => event.as_ref(),
                    event => event,
                };
                if matches!(call, AgentEvent::ToolCall { .. }) {
                    self.emit(event).await?;
                }
            }
        }
        let kind = tool["kind"].as_str().unwrap_or_default();
        if self.text {
            self.client.respond(&id, choose(&options, ApprovalDecision::Deny));
            return Ok(());
        }
        let free = self.access == AccessMode::FullAccess || (self.access == AccessMode::AutoAcceptEdits && kind == "edit");
        if free {
            self.client.respond(&id, choose(&options, ApprovalDecision::Allow));
            return Ok(());
        }
        let title = match kind {
            "execute" => "Run command".to_owned(),
            "edit" => "Edit file".to_owned(),
            "delete" => "Delete file".to_owned(),
            "move" => "Move file".to_owned(),
            "fetch" => "Fetch from the web".to_owned(),
            _ => tool["title"]
                .as_str()
                .map(str::trim)
                .filter(|t| !t.is_empty())
                .map_or_else(|| "Allow tool".to_owned(), str::to_owned),
        };
        let request = InputRequest::Approval {
            title,
            call: self.normalizer.call(&call_id).cloned(),
            tool_call_id: Some(call_id).filter(|i| !i.is_empty()),
            reason: None,
        };
        self.pending
            .insert(request_id.clone(), Pending::Approval { rpc_id: id, options });
        self.emit(AgentEvent::InputRequested { request_id, request }).await
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
                    self.begin(prompt).await
                }
            }
            RunCommand::Answer { request_id, response } => self.answer(request_id, response).await,
            RunCommand::SetModes { access, plan } => {
                self.access = access;
                self.plan = plan;
                self.apply_mode().await;
                Ok(())
            }
            // The agent's background work ends with its turn.
            RunCommand::StopTask { .. } => Ok(()),
            RunCommand::Interrupt => {
                if self.turn.is_none() || self.interrupt_deadline.is_some() {
                    return Ok(());
                }
                // Whatever the turn waited on is cancelled, so it can stop.
                for (request_id, pending) in self.pending.drain().collect::<Vec<_>>() {
                    let (Pending::Approval { rpc_id, .. } | Pending::Question { rpc_id, .. }) = &pending;
                    self.client.respond(rpc_id, cancelled());
                    self.emit(AgentEvent::InputResolved {
                        request_id,
                        response: None,
                    })
                    .await?;
                }
                self.client
                    .notify("session/cancel", json!({ "sessionId": self.session_id }));
                self.interrupt_deadline = Some(Instant::now() + INTERRUPT_SETTLE);
                Ok(())
            }
            RunCommand::Close => {
                self.close();
                Ok(())
            }
        }
    }

    /// Ends the session once the turn in flight ends.
    fn close(&mut self) {
        self.closing = true;
        self.queue.clear();
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
            (Pending::Approval { rpc_id, options }, response) => {
                let decision = match response {
                    InputResponse::Approval { decision } => decision,
                    _ => ApprovalDecision::Deny,
                };
                self.client.respond(&rpc_id, choose(&options, decision));
            }
            (Pending::Question { rpc_id, options }, response) => {
                let label = match response {
                    InputResponse::Questions { answers } => answers.into_iter().find_map(|a| a.labels.into_iter().next()),
                    _ => None,
                };
                let picked = label.and_then(|label| {
                    options
                        .iter()
                        .find(|o| option_name(o) == Some(label.as_str()))
                        .and_then(|o| o["optionId"].as_str())
                });
                let outcome = match picked {
                    Some(option) => selected(option),
                    None => cancelled(),
                };
                self.client.respond(&rpc_id, outcome);
            }
        }
        Ok(())
    }

    /// Nobody listens any more: the agent goes down in the background.
    fn abandon(self) {
        let Session { client, mut child, .. } = self;
        drop(client);
        tokio::spawn(async move { retire(&mut child).await });
    }

    /// The agent exited or the run closed. A turn still in flight ends here.
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
        drop(client); // Closes stdin: the agent saves and exits.
        let status = retire(&mut child).await;
        if !in_flight {
            return;
        }
        let status = if closing {
            DoneStatus::Interrupted
        } else {
            let message = stderr.under(format!(
                "Antigravity exited unexpectedly (exit code {}).",
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

/// Waits for an agent whose stdin closed to save and exit, then stops it.
async fn retire(child: &mut Child) -> Option<std::process::ExitStatus> {
    if let Ok(status) = tokio::time::timeout(EXIT_GRACE, child.wait()).await {
        return status.ok();
    }
    acp::retire(child).await
}

/// The UI's request id for an agent request.
fn request_key(id: &Value) -> String {
    match id {
        Value::String(s) => format!("agy-{s}"),
        other => format!("agy-{other}"),
    }
}

fn option_name(option: &Value) -> Option<&str> {
    option["name"]
        .as_str()
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .or_else(|| option["optionId"].as_str())
}

fn selected(option_id: &str) -> Value {
    json!({ "outcome": { "outcome": "selected", "optionId": option_id } })
}

fn cancelled() -> Value {
    json!({ "outcome": { "outcome": "cancelled" } })
}

/// The permission option that carries `decision`, by its kind; with none
/// to pick, the request is cancelled.
fn choose(options: &[Value], decision: ApprovalDecision) -> Value {
    let kinds: &[&str] = match decision {
        ApprovalDecision::Allow => &["allow_once", "allow_always"],
        ApprovalDecision::AllowSession => &["allow_always", "allow_once"],
        ApprovalDecision::Deny => &["reject_once", "reject_always"],
    };
    kinds
        .iter()
        .find_map(|kind| {
            options
                .iter()
                .find(|o| o["kind"].as_str() == Some(kind))
                .and_then(|o| o["optionId"].as_str())
        })
        .map_or_else(cancelled, selected)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decisions_pick_options_by_kind() {
        let options = vec![
            json!({ "optionId": "allow", "name": "Allow", "kind": "allow_once" }),
            json!({ "optionId": "deny", "name": "Deny", "kind": "reject_once" }),
        ];
        assert_eq!(choose(&options, ApprovalDecision::Allow), selected("allow"));
        assert_eq!(choose(&options, ApprovalDecision::AllowSession), selected("allow"));
        assert_eq!(choose(&options, ApprovalDecision::Deny), selected("deny"));
        assert_eq!(choose(&[], ApprovalDecision::Allow), cancelled());
    }

    #[test]
    fn access_maps_onto_modes() {
        assert_eq!(mode_for(AccessMode::Supervised, false, false), "default");
        assert_eq!(mode_for(AccessMode::AutoAcceptEdits, false, false), "accept-edits");
        assert_eq!(mode_for(AccessMode::FullAccess, false, false), "accept-edits");
        assert_eq!(mode_for(AccessMode::FullAccess, true, false), "plan");
        assert_eq!(mode_for(AccessMode::FullAccess, true, true), "default");
    }

    #[test]
    fn mcp_server_rides_as_stdio() {
        let mcp = McpServer {
            name: "outcode".into(),
            command: "/opt/outcode".into(),
            args: vec!["mcp".into()],
            env: [("OUTCODE_CHAT_ID".to_owned(), "c1".to_owned())].into(),
        };
        assert_eq!(
            mcp_servers(Some(&mcp)),
            json!([{ "name": "outcode", "command": "/opt/outcode", "args": ["mcp"],
                     "env": [{ "name": "OUTCODE_CHAT_ID", "value": "c1" }] }])
        );
        assert_eq!(mcp_servers(None), json!([]));
    }

    #[test]
    fn config_options_read_their_choices() {
        let options = json!([
            { "id": "model", "currentValue": "gemini-4-hydrogen", "type": "select",
              "options": [{ "value": "gemini-4-hydrogen" }, { "value": "gemini-3.8-flash" }] },
            { "id": "thought_level", "currentValue": "high", "type": "select",
              "options": [{ "value": "low" }, { "value": "high" }] }
        ]);
        assert_eq!(
            config_option(&options, "model"),
            Some(("gemini-4-hydrogen", vec!["gemini-4-hydrogen", "gemini-3.8-flash"]))
        );
        assert_eq!(config_option(&options, "thought_level").unwrap().1, ["low", "high"]);
        assert_eq!(config_option(&options, "mode"), None);
    }
}
