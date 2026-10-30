//! Hive's own MCP server: the tools agents get as `hive` (`mcp__hive__*` in
//! Claude). The app hosts them on a loopback port (`hive_mcp::Host`); each
//! agent's CLI launches this executable as `hive mcp` to relay to it.
//!
//! A new tool is one more `.tool(name, description, schema, handler)` in
//! [`tools`]. Handlers get the calling chat (`ctx.chat_id`) and the app, so
//! they can reach the engine, settings or the window.

use std::path::Path;

use hive_engine::Engine;
use hive_mcp::{Ctx, Host, McpServer, Tools};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::{html, secrets};

/// Starts the host and returns how agents launch a bridge to it; None (and
/// agents run without it) when it can't.
pub fn start(app: &AppHandle, data_dir: &Path) -> Option<McpServer> {
    let exe = std::env::current_exe().ok()?.to_str()?.to_owned();
    match Host::start(tools(app), data_dir, tauri::async_runtime::handle().inner()) {
        Ok(host) => Some(host.server(exe, vec!["mcp".into()])),
        Err(e) => {
            log::warn!("Hive's MCP server didn't start: {e}");
            None
        }
    }
}

fn tools(app: &AppHandle) -> Tools {
    let whoami_app = app.clone();
    let secrets_app = app.clone();
    let preview_app = app.clone();
    let render_app = app.clone();
    Tools::new()
        .tool(
            "whoami",
            "The Hive chat you're running in: its id, title, folder (and worktree), agent and model.",
            json!({ "type": "object", "properties": {} }),
            move |ctx, _| {
                let result = whoami(&whoami_app, &ctx);
                async move { result }
            },
        )
        .tool(
            secrets::TOOL,
            secrets::DESCRIPTION,
            secrets::schema(),
            move |ctx, args| secrets::request(secrets_app.clone(), ctx, args),
        )
        .tool(
            html::PREVIEW_TOOL,
            html::preview_description(),
            html::preview_schema(),
            move |_, args| html::preview(preview_app.clone(), args),
        )
        .tool(
            html::RENDER_TOOL,
            html::render_description(),
            html::render_schema(),
            move |ctx, args| html::render(render_app.clone(), ctx, args),
        )
}

fn whoami(app: &AppHandle, ctx: &Ctx) -> Result<Value, String> {
    let chat = calling_chat(app, ctx)?;
    Ok(json!({
        "chatId": chat.id,
        "title": chat.title,
        "folder": chat.cwd,
        "workDir": chat.work_dir(),
        "worktree": chat.worktree.as_ref().map(|w| json!({ "branch": w.branch, "base": w.base })),
        "harness": chat.config.harness,
        "model": chat.config.model,
    }))
}

/// The chat whose agent called.
fn calling_chat(app: &AppHandle, ctx: &Ctx) -> Result<hive_proto::Chat, String> {
    let id = ctx
        .chat_id
        .as_deref()
        .ok_or("This session isn't a Hive chat.")?;
    let engine = app.try_state::<Engine>().ok_or("Hive is still starting.")?;
    engine
        .chats()
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|c| c.id == id)
        .ok_or_else(|| format!("Chat {id} no longer exists."))
}
