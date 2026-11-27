//! Agents running agents: tools that start other agents, each in an Outcode
//! chat of its own (`outcode_engine`'s children), and hear back from them.
//! A chat started this way doesn't get these tools: no chats of chats.

use std::time::Duration;

use outcode_engine::{ChildAgent, ChildStatus, MAX_WORKING_CHILDREN};
use outcode_mcp::{Ctx, Tools};
use outcode_proto::{HarnessId, ReasoningLevel};
use serde::Deserialize;
use serde_json::{Value, json};
use tauri::AppHandle;

use super::{args, calling_chat, engine};

const TOOLS: [&str; 6] = ["list_agents", "start_chat", "wait_chat", "message_chat", "stop_chat", "list_chats"];
const WAIT: u64 = 10 * 60;
const MAX_WAIT: u64 = 60 * 60;

/// Adds the agent tools to `tools`, offered only to a chat no agent started.
pub(super) fn tools(tools: Tools, app: &AppHandle) -> Tools {
    let (a, b, c, d, e, f, g) = (app.clone(), app.clone(), app.clone(), app.clone(), app.clone(), app.clone(), app.clone());
    let id = |description: &str| json!({ "type": "string", "description": description });
    tools
        .tool(
            "list_agents",
            "The coding agents start_chat can run: each harness, whether its CLI is installed, and its models with the efforts each takes.",
            json!({ "type": "object", "properties": {}, "additionalProperties": false }),
            move |_, _| list_agents(a.clone()),
        )
        .tool(
            "start_chat",
            format!(
                "Start another coding agent (Claude Code, Codex or Antigravity, on the model you pick; list_agents names them) \
                 in a new Outcode chat of its own, in your folder and worktree, with your access and plan mode. It returns at once \
                 with the chat's id while the agent works in the background; call wait_chat for its reply. It hasn't seen this \
                 conversation: put everything it needs in the prompt. The user sees the chat under yours and can open, answer or \
                 stop it. Agents you start can't start chats of their own (their own subagents still work). At most \
                 {MAX_WORKING_CHILDREN} of your chats work at once."
            ),
            json!({
                "type": "object",
                "properties": {
                    "harness": { "type": "string", "enum": ["claude", "codex", "antigravity"], "description": "The CLI it runs on." },
                    "model": { "type": "string", "description": "A model id from list_agents. Default: yours on the same harness, else the CLI's default." },
                    "reasoning": { "type": "string", "enum": ["low", "medium", "high", "xhigh", "max"], "description": "Its effort, where the model takes one." },
                    "prompt": { "type": "string", "description": "Its first prompt: the whole task, self-contained." },
                    "title": { "type": "string", "description": "The chat's title. Default: written from the prompt." }
                },
                "required": ["harness", "prompt"],
                "additionalProperties": false
            }),
            move |ctx, args| start_chat(b.clone(), ctx, args),
        )
        .tool(
            "wait_chat",
            "Wait for a chat you started to finish its turn, then get its reply (the text it ended on). It returns early, state \
             waitingOnUser, when the chat starts waiting on the user (an approval or a question in that chat): tell the user \
             instead of calling again right away. After timeoutSec it returns with state working: call it again to keep waiting.",
            json!({
                "type": "object",
                "properties": {
                    "chatId": id("The chat start_chat returned."),
                    "timeoutSec": { "type": "integer", "minimum": 1, "maximum": MAX_WAIT, "description": "How long to wait. Default 600." }
                },
                "required": ["chatId"],
                "additionalProperties": false
            }),
            move |ctx, args| wait_chat(c.clone(), ctx, args),
        )
        .tool(
            "message_chat",
            "Send a follow-up prompt to a chat you started (it remembers its own conversation). It goes once its running turn \
             ends; call wait_chat for the reply.",
            json!({
                "type": "object",
                "properties": { "chatId": id("The chat."), "prompt": { "type": "string" } },
                "required": ["chatId", "prompt"],
                "additionalProperties": false
            }),
            move |ctx, args| message_chat(d.clone(), ctx, args),
        )
        .tool(
            "stop_chat",
            "Stop a chat you started: its running turn ends. The chat stays; message_chat starts it again.",
            json!({
                "type": "object",
                "properties": { "chatId": id("The chat.") },
                "required": ["chatId"],
                "additionalProperties": false
            }),
            move |ctx, args| stop_chat(e.clone(), ctx, args),
        )
        .tool(
            "list_chats",
            "The chats you started, most recently active first, and how each stands (wait_chat has their replies).",
            json!({ "type": "object", "properties": {}, "additionalProperties": false }),
            move |ctx, _| list_chats(f.clone(), ctx),
        )
        // A chat an agent started (or a session that's no chat) doesn't get them.
        .shown_when(move |ctx, name| {
            !TOOLS.contains(&name) || calling_chat(&g, ctx).is_ok_and(|chat| chat.parent_chat_id.is_none())
        })
}

async fn list_agents(app: AppHandle) -> Result<Value, String> {
    let engine = engine(&app)?;
    let mut agents = Vec::new();
    for id in HarnessId::ALL {
        let Some(harness) = engine.harness(id).cloned() else {
            continue;
        };
        let catalog = tokio::task::spawn_blocking(move || harness.catalog()).await.map_err(|e| e.to_string())?;
        let models: Vec<Value> = catalog
            .models
            .iter()
            .map(|m| json!({ "id": m.id, "label": m.label, "efforts": m.reasoning_levels }))
            .collect();
        agents.push(json!({
            "harness": id,
            "installed": catalog.installed,
            "defaultModel": catalog.default_model,
            "models": models,
        }));
    }
    Ok(json!({ "agents": agents }))
}

#[derive(Deserialize)]
struct StartArgs {
    harness: HarnessId,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    reasoning: Option<ReasoningLevel>,
    prompt: String,
    #[serde(default)]
    title: Option<String>,
}

async fn start_chat(app: AppHandle, ctx: Ctx, raw: Value) -> Result<Value, String> {
    let StartArgs { harness, model, reasoning, prompt, title } = args(raw)?;
    let parent = calling_chat(&app, &ctx)?;
    let engine = engine(&app)?;
    if engine.harness(harness).is_none() {
        return Err(format!("Outcode can't run {}.", harness.as_str()));
    }
    let agent = ChildAgent { harness, model, reasoning };
    let chat = engine.start_child(&parent.id, agent, title, prompt).map_err(|e| e.to_string())?;
    Ok(json!({
        "chatId": chat.id,
        "harness": chat.config.harness,
        "model": chat.config.model,
        "note": "It's working in the background. Call wait_chat for its reply.",
    }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatArgs {
    chat_id: String,
    #[serde(default)]
    timeout_sec: Option<u64>,
    #[serde(default)]
    prompt: Option<String>,
}

/// The caller's child `chat_id`.
fn child(app: &AppHandle, ctx: &Ctx, chat_id: &str) -> Result<outcode_proto::Chat, String> {
    let parent = calling_chat(app, ctx)?;
    engine(app)?.child(&parent.id, chat_id.trim()).map_err(|e| e.to_string())
}

async fn wait_chat(app: AppHandle, ctx: Ctx, raw: Value) -> Result<Value, String> {
    let ChatArgs { chat_id, timeout_sec, .. } = args(raw)?;
    let chat = child(&app, &ctx, &chat_id)?;
    let wait = Duration::from_secs(timeout_sec.unwrap_or(WAIT).clamp(1, MAX_WAIT));
    let status = engine(&app)?.wait_child(&chat, wait).await.map_err(|e| e.to_string())?;
    Ok(status_json(&status, true))
}

async fn message_chat(app: AppHandle, ctx: Ctx, raw: Value) -> Result<Value, String> {
    let ChatArgs { chat_id, prompt, .. } = args(raw)?;
    let prompt = prompt.filter(|p| !p.trim().is_empty()).ok_or("Give it a prompt.")?;
    let chat = child(&app, &ctx, &chat_id)?;
    engine(&app)?.send(&chat.id, prompt, Vec::new()).map_err(|e| e.to_string())?;
    Ok(json!({ "chatId": chat.id, "note": "Sent. Call wait_chat for the reply." }))
}

async fn stop_chat(app: AppHandle, ctx: Ctx, raw: Value) -> Result<Value, String> {
    let ChatArgs { chat_id, .. } = args(raw)?;
    let chat = child(&app, &ctx, &chat_id)?;
    engine(&app)?.interrupt(&chat.id);
    Ok(json!({ "chatId": chat.id, "stopped": true }))
}

async fn list_chats(app: AppHandle, ctx: Ctx) -> Result<Value, String> {
    let parent = calling_chat(&app, &ctx)?;
    let engine = engine(&app)?;
    let mut chats = Vec::new();
    for chat in engine.children(&parent.id).map_err(|e| e.to_string())? {
        let status = engine.child_status(&chat).map_err(|e| e.to_string())?;
        chats.push(status_json(&status, false));
    }
    Ok(json!({ "chats": chats }))
}

/// How a child stands, for its parent; with its reply when `reply`.
fn status_json(status: &ChildStatus, reply: bool) -> Value {
    let chat = &status.chat;
    let mut value = json!({
        "chatId": chat.id,
        "title": chat.title,
        "harness": chat.config.harness,
        "model": chat.config.model,
        "state": status.state.as_str(),
    });
    if status.queued > 0 {
        value["queuedPrompts"] = json!(status.queued);
    }
    if status.stopped {
        value["stopped"] = json!(true);
    }
    if let Some(error) = &status.error {
        value["error"] = json!(error);
    }
    if reply {
        value["reply"] = json!(status.reply);
    }
    value
}
