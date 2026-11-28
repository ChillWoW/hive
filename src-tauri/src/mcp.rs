//! Outcode's own MCP server: the tools agents get as `outcode`
//! (`mcp__outcode__*` in Claude). The app hosts them on a loopback port
//! (`outcode_mcp::Host`); each agent's CLI launches this executable as
//! `outcode mcp` to relay to it.
//!
//! - `whoami`: the chat the agent runs in.
//! - `show_image` / `show_svg`: an image shown where the call is; a copy is
//!   kept as an attachment, which the transcript reads from the call's result.
//! - `preview_html` / `render_html`: a static check of a page, then the page
//!   shown in a sandboxed frame where the call is (its scripts run there, with
//!   no access to Outcode).
//! - `request_secret`: a private card asking the user for a secret; the value
//!   goes to a file only the user can read, and the agent gets its path.
//! - `start_chat` and the rest ([`agents`]): other agents, each in a chat of
//!   its own.
//! - `browser_open` and the rest ([`browser`]): the browser tabs in the tabs
//!   panel, shared with the user.

mod agents;
mod browser;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use outcode_engine::Engine;
use outcode_mcp::{Ctx, Host, Tools};
use outcode_proto::{Chat, SecretRequest};
use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use tauri::{AppHandle, Manager, State};
use tokio::sync::oneshot;

const MAX_IMAGE: u64 = 20 * 1024 * 1024;
const MAX_SVG: usize = 2 * 1024 * 1024;
const MAX_HTML: usize = 512_000;
const SECRET_WAIT: Duration = Duration::from_secs(10 * 60);
const MAX_SECRET_WAIT: u64 = 60 * 60;

const SHOWN: &str = "Shown to the user above your reply. Don't describe it; reply with only what it doesn't already say.";

/// Starts the host and hands the engine how agents launch a bridge to it;
/// agents run without it when it can't start.
pub fn start(app: &AppHandle, data_dir: &Path, engine: &Engine) {
    let Some(exe) = std::env::current_exe().ok().and_then(|p| p.to_str().map(str::to_owned)) else {
        return;
    };
    match Host::start(tools(app), data_dir, tauri::async_runtime::handle().inner()) {
        Ok(host) => engine.set_mcp(Some(host.server(exe, vec!["mcp".into()]))),
        Err(e) => log::warn!("Outcode's MCP server didn't start: {e}"),
    }
}

fn tools(app: &AppHandle) -> Tools {
    let (a, b, c, d, e) = (app.clone(), app.clone(), app.clone(), app.clone(), app.clone());
    let tools = Tools::new()
        .tool(
            "whoami",
            "The Outcode chat you're running in: its id, title, folder and model.",
            json!({ "type": "object", "properties": {} }),
            move |ctx, _| {
                let result = calling_chat(&a, &ctx).map(|chat| {
                    json!({
                        "chatId": chat.id,
                        "title": chat.title,
                        "folder": chat.cwd,
                        "model": chat.config.model,
                        "startedBy": chat.parent_chat_id,
                    })
                });
                async move { result }
            },
        )
        .tool(
            "show_image",
            "Show an image file (PNG, JPEG, GIF, WebP or SVG; 20 MB at most) inline in this Outcode chat, where you call it, above your reply: a screenshot, a rendered plot. Outcode keeps a copy. Call it once per image.",
            json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "The image file: absolute, or relative to the chat's folder." },
                    "caption": { "type": "string", "description": "A short line shown under the image." }
                },
                "required": ["path"],
                "additionalProperties": false
            }),
            move |ctx, args| show_image(b.clone(), ctx, args),
        )
        .tool(
            "show_svg",
            "Show an SVG you write (a diagram, icon or sketch) inline in this Outcode chat, above your reply. It's drawn as an image: no scripts, no external resources; inline everything. Give the root <svg> a viewBox and a width. The chat is dark (#141414): use light strokes and text.",
            json!({
                "type": "object",
                "properties": {
                    "svg": { "type": "string", "description": "The SVG markup." },
                    "caption": { "type": "string", "description": "A short line shown under it." }
                },
                "required": ["svg"],
                "additionalProperties": false
            }),
            move |ctx, args| show_svg(c.clone(), ctx, args),
        )
        .tool(
            "preview_html",
            "Check an HTML page before render_html: reports its size, title, scripts and anything render_html would refuse. Fix what it reports, then call render_html.",
            html_schema(false),
            |_, args| async move { preview_html(args) },
        )
        .tool(
            "render_html",
            "Show a finished, self-contained HTML page (an interactive chart, diagram or mockup) inline in this Outcode chat, above your reply; its JavaScript runs sandboxed (no access to Outcode, cookies or storage). Inline <style> and <script>; https CDNs load. Leave html and body without a background: the chat is dark (#141414), so use light text. Never use viewport heights (vh); give the frame's height instead.",
            html_schema(true),
            move |ctx, args| render_html(d.clone(), ctx, args),
        )
        .tool(
            "request_secret",
            "Ask the user for a secret (an API key, token or password) in a private card in Outcode, and wait for them. The value never appears in the chat: you get the path of a private file holding it. Read it inside your commands (TOKEN=\"$(cat <file>)\" some-cli login) and never print or copy it. When you need a secret, call this instead of asking in chat.",
            json!({
                "type": "object",
                "properties": {
                    "label": { "type": "string", "description": "The card's title, e.g. \"Tailscale auth key\"." },
                    "reason": { "type": "string", "description": "What it's for and where to get it." },
                    "placeholder": { "type": "string", "description": "The empty field's hint." },
                    "timeoutSec": { "type": "integer", "minimum": 10, "maximum": MAX_SECRET_WAIT, "description": "How long to wait. Default 600." }
                },
                "required": ["label", "reason"],
                "additionalProperties": false
            }),
            move |ctx, args| request_secret(e.clone(), ctx, args),
        );
    browser::tools(agents::tools(tools, app), app)
}

fn html_schema(render: bool) -> Value {
    let mut properties = json!({
        "html": { "type": "string", "description": "One self-contained HTML document." },
    });
    if render {
        properties["title"] = json!({ "type": "string", "description": "A short title shown over the frame." });
        properties["height"] = json!({ "type": "integer", "minimum": 80, "maximum": 1600, "description": "The frame's height in pixels. Default 420." });
    }
    json!({ "type": "object", "properties": properties, "required": ["html"], "additionalProperties": false })
}

fn engine(app: &AppHandle) -> Result<Engine, String> {
    Ok(app.try_state::<Engine>().ok_or("Outcode is still starting.")?.inner().clone())
}

/// The chat whose agent called.
fn calling_chat(app: &AppHandle, ctx: &Ctx) -> Result<Chat, String> {
    let id = ctx.chat_id.as_deref().ok_or("This session isn't an Outcode chat.")?;
    engine(app)?
        .store()
        .chat(id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Chat {id} no longer exists."))
}

fn args<T: DeserializeOwned>(args: Value) -> Result<T, String> {
    serde_json::from_value(args).map_err(|e| format!("Bad arguments: {e}"))
}

#[derive(Deserialize)]
struct ImageArgs {
    path: String,
    #[serde(default)]
    caption: Option<String>,
}

async fn show_image(app: AppHandle, ctx: Ctx, raw: Value) -> Result<Value, String> {
    let ImageArgs { path, caption } = args(raw)?;
    let chat = calling_chat(&app, &ctx)?;
    let mut file = PathBuf::from(path.trim());
    if file.is_relative() {
        file = Path::new(chat.work_dir()).join(file);
    }
    let meta = tokio::fs::metadata(&file).await.map_err(|e| format!("{}: {e}", file.display()))?;
    if !meta.is_file() || meta.len() > MAX_IMAGE {
        return Err(format!("{} isn't an image file of 20 MB or less.", file.display()));
    }
    let bytes = tokio::fs::read(&file).await.map_err(|e| e.to_string())?;
    let name = file.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "image".into());
    let is_svg = name.to_ascii_lowercase().ends_with(".svg");
    if outcode_harness::attachments::image_type(&bytes).is_none() && !is_svg {
        return Err(format!("{} isn't a PNG, JPEG, GIF, WebP or SVG image.", file.display()));
    }
    shown(&app, &name, &bytes, caption)
}

#[derive(Deserialize)]
struct SvgArgs {
    svg: String,
    #[serde(default)]
    caption: Option<String>,
}

async fn show_svg(app: AppHandle, ctx: Ctx, raw: Value) -> Result<Value, String> {
    let SvgArgs { svg, caption } = args(raw)?;
    calling_chat(&app, &ctx)?;
    if svg.len() > MAX_SVG || !svg.contains("<svg") {
        return Err("Send one <svg> document of 2 MB or less.".into());
    }
    shown(&app, "drawing.svg", svg.as_bytes(), caption)
}

/// Keeps a copy of what's shown; the transcript draws it from the result.
fn shown(app: &AppHandle, name: &str, bytes: &[u8], caption: Option<String>) -> Result<Value, String> {
    let mut attachment = engine(app)?.store().save_attachment(name, bytes).map_err(|e| e.to_string())?;
    if name.to_ascii_lowercase().ends_with(".svg") {
        attachment.mime_type = "image/svg+xml".into();
    }
    Ok(json!({
        "shown": SHOWN,
        "attachment": attachment,
        "caption": caption.map(|c| c.trim().chars().take(300).collect::<String>()).filter(|c| !c.is_empty()),
    }))
}

#[derive(Deserialize)]
struct HtmlArgs {
    html: String,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    height: Option<u32>,
}

/// What render_html would refuse, and a little about the page.
fn check_html(html: &str) -> (Vec<String>, Value) {
    let mut problems = Vec::new();
    if html.trim().is_empty() {
        problems.push("The page is empty.".into());
    }
    if html.len() > MAX_HTML {
        problems.push(format!("The page is {} bytes; 512 KB at most.", html.len()));
    }
    let lower = html.to_ascii_lowercase();
    // A number right before `vh`/`dvh`/`svh`/`lvh`, and no letter after it.
    let bytes = lower.as_bytes();
    let viewport = lower.match_indices("vh").any(|(at, _)| {
        let unit_start = if at > 0 && matches!(bytes[at - 1], b'd' | b's' | b'l') { at - 1 } else { at };
        let after = bytes.get(at + 2).copied();
        unit_start > 0 && bytes[unit_start - 1].is_ascii_digit() && !after.is_some_and(|b| b.is_ascii_alphabetic())
    });
    if viewport {
        problems.push("It uses viewport heights (vh): give fixed pixel heights instead.".into());
    }
    let title = lower
        .find("<title>")
        .and_then(|start| {
            let rest = &html[start + 7..];
            rest.to_ascii_lowercase().find("</title>").map(|end| rest[..end].trim().to_owned())
        })
        .filter(|t| !t.is_empty());
    let facts = json!({
        "bytes": html.len(),
        "title": title,
        "scripts": lower.matches("<script").count(),
        "styles": lower.matches("<style").count(),
    });
    (problems, facts)
}

fn preview_html(raw: Value) -> Result<Value, String> {
    let HtmlArgs { html, .. } = args(raw)?;
    let (problems, facts) = check_html(&html);
    Ok(json!({
        "ok": problems.is_empty(),
        "problems": problems,
        "page": facts,
        "note": "A static check: scripts aren't run here. Keep the page self-contained.",
    }))
}

async fn render_html(app: AppHandle, ctx: Ctx, raw: Value) -> Result<Value, String> {
    let HtmlArgs { html, title, height } = args(raw)?;
    calling_chat(&app, &ctx)?;
    let (problems, _) = check_html(&html);
    if !problems.is_empty() {
        return Err(problems.join(" "));
    }
    let attachment = engine(&app)?
        .store()
        .save_attachment("page.html", html.as_bytes())
        .map_err(|e| e.to_string())?;
    Ok(json!({
        "shown": SHOWN,
        "attachment": attachment,
        "title": title.map(|t| t.trim().chars().take(200).collect::<String>()).filter(|t| !t.is_empty()),
        "height": height.unwrap_or(420).clamp(80, 1600),
    }))
}

/// Secret cards waiting on the user, by request id.
#[derive(Default)]
pub struct SecretRequests(Mutex<HashMap<String, oneshot::Sender<Option<String>>>>);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SecretArgs {
    label: String,
    reason: String,
    #[serde(default)]
    placeholder: Option<String>,
    #[serde(default)]
    timeout_sec: Option<u64>,
}

async fn request_secret(app: AppHandle, ctx: Ctx, raw: Value) -> Result<Value, String> {
    let SecretArgs { label, reason, placeholder, timeout_sec } = args(raw)?;
    let chat = calling_chat(&app, &ctx)?;
    let engine = engine(&app)?;
    let id = uuid_like();
    let (tx, rx) = oneshot::channel();
    app.state::<SecretRequests>().0.lock().unwrap().insert(id.clone(), tx);
    engine.open_secret_request(
        &chat.id,
        SecretRequest {
            id: id.clone(),
            label: label.trim().into(),
            reason: reason.trim().into(),
            placeholder: placeholder.filter(|p| !p.trim().is_empty()),
        },
    );
    let wait = timeout_sec.map_or(SECRET_WAIT, |s| Duration::from_secs(s.clamp(10, MAX_SECRET_WAIT)));
    let answer = tokio::time::timeout(wait, rx).await;
    app.state::<SecretRequests>().0.lock().unwrap().remove(&id);
    engine.close_secret_request(&chat.id, &id);
    let value = match answer {
        Ok(Ok(Some(value))) => value,
        Ok(Ok(None)) | Ok(Err(_)) => return Err("The user declined to give it.".into()),
        Err(_) => return Err("The user didn't answer in time.".into()),
    };
    let dir = app
        .path()
        .home_dir()
        .map_err(|e| e.to_string())?
        .join(if app.config().identifier.ends_with(".dev") { ".outcode.dev" } else { ".outcode" })
        .join("secrets")
        .join(&chat.id);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let file = dir.join(&id);
    write_private(&file, value.as_bytes()).map_err(|e| e.to_string())?;
    Ok(json!({
        "file": file.display().to_string(),
        "note": "Read it inside your commands; never print, echo or copy it.",
    }))
}

/// Writes `bytes` to a new file only the user can read (owner-only on unix;
/// the data folder is already private to the user on Windows).
fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)?.write_all(bytes)
}

fn uuid_like() -> String {
    outcode_store::new_id()
}

/// The user's answer to a secret card; `None` declines.
#[tauri::command]
pub fn secret_answer(requests: State<'_, SecretRequests>, id: String, value: Option<String>) -> Result<(), String> {
    let sender = requests.0.lock().unwrap().remove(&id).ok_or("That request has ended.")?;
    let _ = sender.send(value.filter(|v| !v.is_empty()));
    Ok(())
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pages_with_viewport_heights_are_refused() {
        assert!(check_html("<div style='height:100vh'></div>").0.len() == 1);
        assert!(check_html("<title> Chart </title><canvas height=300></canvas>").0.is_empty());
        assert_eq!(check_html("<title> Chart </title>").1["title"], "Chart");
        assert!(!check_html("").0.is_empty());
    }
}
