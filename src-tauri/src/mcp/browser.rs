//! Agents in the browser: the `browser_*` tools, which act on the browser
//! tabs in Outcode's tabs panel (`crate::browser`). The tabs are shared: an
//! agent's show up in the user's tab strip, and an agent can act on a tab
//! the user opened.
//!
//! Reading and navigating are free. Running script and uploading files act
//! with whatever the tab is signed in to, so a supervised chat's agent is
//! refused those.

use std::future::Future;
use std::path::{Path, PathBuf};
use std::time::Duration;

use base64::Engine as _;
use outcode_mcp::{Ctx, IMAGES_KEY, Tools};
use outcode_proto::AccessMode;
use serde::Deserialize;
use serde_json::{Value, json};
use tauri::{AppHandle, Manager};

use super::{args, calling_chat};
use crate::browser::{Browsers, Clip, Go, JsError, SCREENSHOTS, Shot, Viewport, parse_url};

/// How long a navigation may take before its tool returns anyway.
const LOAD_WAIT: Duration = Duration::from_secs(30);
/// How long an action waits to see whether it started a page load.
const ACTION_GRACE: Duration = Duration::from_millis(350);
const ACTION_LOAD_WAIT: Duration = Duration::from_secs(15);
const RUN_WAIT: u64 = 30;
const MAX_RUN_WAIT: u64 = 300;
const WAIT_FOR: u64 = 10;
const MAX_WAIT_FOR: u64 = 120;
const MAX_UPLOAD: u64 = 24 * 1024 * 1024;
const MAX_RESULT: usize = 100_000;

const TAB: &str = "The tab's id (browser_tabs lists them). Default: the tab you last used, else the one on screen.";
const TARGET: &str = "The element: a ref from browser_snapshot (e12), or a CSS selector.";

fn add<F, Fut>(tools: Tools, app: &AppHandle, name: &str, description: &str, properties: Value, required: &[&str], run: F) -> Tools
where
    F: Fn(AppHandle, Ctx, Value) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = Result<Value, String>> + Send + 'static,
{
    let app = app.clone();
    let schema = json!({ "type": "object", "properties": properties, "required": required, "additionalProperties": false });
    tools.tool(name, description, schema, move |ctx, args| run(app.clone(), ctx, args))
}

/// Adds the browser tools to `tools`.
pub(super) fn tools(tools: Tools, app: &AppHandle) -> Tools {
    let tab = || json!({ "type": "string", "description": TAB });
    let target = || json!({ "type": "string", "description": TARGET });
    let mut t = tools;
    t = add(
        t,
        app,
        "browser_open",
        "Open a new browser tab in Outcode's tabs panel, on a URL (blank without one), and wait for the page to load. \
         The tab is shared with the user: they see it and can use it too. It's a real browser with its own profile \
         (sign-ins persist), apart from the user's everyday browser. Bare hosts work: localhost:3000, example.com. \
         Returns the tab's id; your later browser calls use that tab by default.",
        json!({ "url": { "type": "string", "description": "Where to go. Default: a blank tab." } }),
        &[],
        open,
    );
    t = add(
        t,
        app,
        "browser_navigate",
        "Load a URL in a browser tab and wait for the page.",
        json!({ "url": { "type": "string" }, "tabId": tab() }),
        &["url"],
        navigate,
    );
    t = add(t, app, "browser_back", "Go back one page in a browser tab's history.", json!({ "tabId": tab() }), &[], |a, c, v| {
        go(a, c, v, Go::Back)
    });
    t = add(t, app, "browser_forward", "Go forward one page in a browser tab's history.", json!({ "tabId": tab() }), &[], |a, c, v| {
        go(a, c, v, Go::Forward)
    });
    t = add(t, app, "browser_reload", "Reload a browser tab's page and wait for it.", json!({ "tabId": tab() }), &[], |a, c, v| {
        go(a, c, v, Go::Reload)
    });
    t = add(t, app, "browser_close", "Close a browser tab.", json!({ "tabId": tab() }), &[], close);
    t = add(
        t,
        app,
        "browser_resize",
        "Show a browser tab's page at a fixed size in CSS pixels (to check a layout at a phone's or a desktop's width), \
         or back at the panel's own size. A page larger than the panel is scaled down to fit; it still lays out at the size you gave.",
        json!({
            "width": { "type": "integer", "minimum": 200, "maximum": 3840 },
            "height": { "type": "integer", "minimum": 200, "maximum": 2160 },
            "preset": { "type": "string", "enum": ["phone", "tablet", "desktop", "fit"], "description": "Instead of width and height: phone 390×844, tablet 820×1180, desktop 1440×900, fit the panel's size." },
            "tabId": tab()
        }),
        &[],
        resize,
    );
    t = add(t, app, "browser_tabs", "List the open browser tabs: id, URL, title, and which one your calls use by default.", json!({}), &[], tabs);
    t = add(
        t,
        app,
        "browser_status",
        "A browser tab's state: URL, title, whether it's loading, its page and viewport sizes, scroll position, and whether the user has it on screen.",
        json!({ "tabId": tab() }),
        &[],
        status,
    );
    t = add(
        t,
        app,
        "browser_snapshot",
        "Read a browser tab's page as a text outline: headings, text, links, buttons and fields, each thing you can act on \
         marked [ref=e12]. Pass those refs to browser_click, browser_type and the rest. Prefer this to a screenshot for \
         reading a page and finding what to click. Refs stay valid until the element leaves the page.",
        json!({
            "selector": { "type": "string", "description": "Only the part of the page under this element (a ref or a CSS selector)." },
            "tabId": tab()
        }),
        &[],
        snapshot,
    );
    t = add(
        t,
        app,
        "browser_screenshot",
        "Take a picture of a browser tab's page, for how it looks (layout, colours, images). You see the picture, and so does the user, in the chat.",
        json!({
            "fullPage": { "type": "boolean", "description": "The whole page, not just the part scrolled into view." },
            "tabId": tab()
        }),
        &[],
        screenshot,
    );
    t = add(
        t,
        app,
        "browser_click",
        "Click an element in a browser tab. Waits for the page if the click loads one.",
        json!({
            "target": target(),
            "button": { "type": "string", "enum": ["left", "right", "middle"] },
            "double": { "type": "boolean", "description": "Double-click." },
            "tabId": tab()
        }),
        &["target"],
        click,
    );
    t = add(
        t,
        app,
        "browser_hover",
        "Move the pointer over an element in a browser tab, for menus and tooltips that show on hover.",
        json!({ "target": target(), "tabId": tab() }),
        &["target"],
        hover,
    );
    t = add(
        t,
        app,
        "browser_type",
        "Type text into a field in a browser tab, replacing what it holds. For a <select>, the text is the option to pick.",
        json!({
            "target": target(),
            "text": { "type": "string" },
            "append": { "type": "boolean", "description": "Add to what's there instead of replacing it." },
            "submit": { "type": "boolean", "description": "Press Enter after." },
            "tabId": tab()
        }),
        &["target", "text"],
        type_text,
    );
    t = add(
        t,
        app,
        "browser_press_key",
        "Press a key in a browser tab: Enter, Escape, Tab, ArrowDown, a, Control+A, Shift+Tab. It goes to the element given, else to whatever has the focus.",
        json!({ "key": { "type": "string" }, "target": target(), "tabId": tab() }),
        &["key"],
        press_key,
    );
    t = add(
        t,
        app,
        "browser_wait_for",
        "Wait until a browser tab's page shows some text or an element matching a CSS selector (or, with gone, until it no longer does).",
        json!({
            "text": { "type": "string", "description": "Text on the page." },
            "selector": { "type": "string", "description": "A CSS selector that must match a visible element." },
            "gone": { "type": "boolean", "description": "Wait for it to go away instead." },
            "timeoutSec": { "type": "integer", "minimum": 1, "maximum": MAX_WAIT_FOR, "description": "Default 10." },
            "tabId": tab()
        }),
        &[],
        wait_for,
    );
    t = add(
        t,
        app,
        "browser_logs",
        "A browser tab's console output, uncaught errors and failed requests (fetch and XHR that errored or answered 4xx/5xx), oldest first. They start over on each page load.",
        json!({
            "level": { "type": "string", "enum": ["all", "errors", "warnings"], "description": "errors: errors and failed requests. warnings: those and warnings. Default all." },
            "limit": { "type": "integer", "minimum": 1, "maximum": 500, "description": "The latest this many. Default 100." },
            "clear": { "type": "boolean", "description": "Empty the log after reading it." },
            "tabId": tab()
        }),
        &[],
        logs,
    );
    t = add(
        t,
        app,
        "browser_run",
        "Run JavaScript in a browser tab's page and get its result as JSON. Give an expression (document.title, await fetch('/api').then(r => r.json())) \
         or statements that return a value. It runs with the page's own access, signed in as the tab is. Not available to a supervised chat.",
        json!({
            "code": { "type": "string" },
            "timeoutSec": { "type": "integer", "minimum": 1, "maximum": MAX_RUN_WAIT, "description": "Default 30." },
            "tabId": tab()
        }),
        &["code"],
        run,
    );
    add(
        t,
        app,
        "browser_upload",
        "Set the files of a file input in a browser tab, as if the user had picked them (24 MB at most in all). Not available to a supervised chat.",
        json!({
            "target": { "type": "string", "description": "The file input, or an element holding one: a ref from browser_snapshot, or a CSS selector." },
            "paths": { "type": "array", "items": { "type": "string" }, "minItems": 1, "description": "The files: absolute, or relative to the chat's folder." },
            "tabId": tab()
        }),
        &["target", "paths"],
        upload,
    )
}

fn browsers(app: &AppHandle) -> Result<tauri::State<'_, Browsers>, String> {
    app.try_state::<Browsers>().ok_or_else(|| "Outcode is still starting.".into())
}

/// The tab a call acts on: the one it names, else the caller's default.
fn tab_of(app: &AppHandle, ctx: &Ctx, tab_id: Option<String>) -> Result<String, String> {
    let browsers = browsers(app)?;
    let id = match tab_id.map(|t| t.trim().to_owned()).filter(|t| !t.is_empty()) {
        Some(id) => id,
        None => browsers
            .default_tab(ctx.chat_id.as_deref())
            .ok_or("No browser tab is open: open one with browser_open.")?,
    };
    if browsers.info(&id).is_none() {
        return Err(format!("There's no browser tab {id}: browser_tabs lists the open ones."));
    }
    Ok(id)
}

/// Refuses a supervised chat's agent: the tool acts with the tab's sign-ins.
fn needs_trust(app: &AppHandle, ctx: &Ctx, tool: &str) -> Result<(), String> {
    let chat = calling_chat(app, ctx)?;
    if chat.config.access == AccessMode::Supervised {
        return Err(format!(
            "{tool} isn't available while this chat is supervised: it acts with whatever the tab is signed in to. \
             Ask the user to do it in the tab, or to give the chat more access."
        ));
    }
    Ok(())
}

/// A string as a JavaScript literal.
fn lit(value: &impl serde::Serialize) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "null".into())
}

/// What a tab is showing, as tools report it.
async fn report(app: &AppHandle, id: &str) -> Value {
    let Ok(browsers) = browsers(app) else {
        return Value::Null;
    };
    let Some(info) = browsers.info(id) else {
        return json!({ "tabId": id, "closed": true });
    };
    let mut out = json!({
        "tabId": id,
        "url": info.url,
        "title": info.title,
        "loading": info.loading,
        "onScreen": browsers.is_shown(id),
    });
    if let Ok(page) = browsers.js(id, "return window.__outcode.status();", Duration::from_secs(5)).await {
        for key in ["url", "title", "viewport", "page", "scroll"] {
            if !page[key].is_null() {
                out[key] = page[key].clone();
            }
        }
    }
    if let Some(v) = info.viewport {
        out["fixedSize"] = json!(v);
    }
    out
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TabArgs {
    #[serde(default)]
    tab_id: Option<String>,
}

#[derive(Deserialize)]
struct OpenArgs {
    #[serde(default)]
    url: Option<String>,
}

async fn open(app: AppHandle, ctx: Ctx, raw: Value) -> Result<Value, String> {
    let OpenArgs { url } = args(raw)?;
    let url = url.filter(|u| !u.trim().is_empty()).map(|u| parse_url(&u, false)).transpose()?;
    let browsers = browsers(&app)?;
    let tab = browsers.open(&app, url, ctx.chat_id.as_deref())?;
    let _driving = browsers.drive(&app, &tab.id, ctx.chat_id.as_deref());
    browsers.settled(&tab.id, 0, LOAD_WAIT, LOAD_WAIT).await;
    Ok(report(&app, &tab.id).await)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NavigateArgs {
    url: String,
    #[serde(default)]
    tab_id: Option<String>,
}

async fn navigate(app: AppHandle, ctx: Ctx, raw: Value) -> Result<Value, String> {
    let NavigateArgs { url, tab_id } = args(raw)?;
    let id = tab_of(&app, &ctx, tab_id)?;
    let url = parse_url(&url, false)?;
    let browsers = browsers(&app)?;
    let _driving = browsers.drive(&app, &id, ctx.chat_id.as_deref());
    let before = browsers.generation(&id);
    browsers.navigate(&app, &id, url)?;
    browsers.settled(&id, before, Duration::from_secs(3), LOAD_WAIT).await;
    Ok(report(&app, &id).await)
}

async fn go(app: AppHandle, ctx: Ctx, raw: Value, go: Go) -> Result<Value, String> {
    let TabArgs { tab_id } = args(raw)?;
    let id = tab_of(&app, &ctx, tab_id)?;
    let browsers = browsers(&app)?;
    let info = browsers.info(&id).ok_or("That tab closed.")?;
    if go == Go::Back && !info.can_go_back {
        return Err("There's no page to go back to.".into());
    }
    if go == Go::Forward && !info.can_go_forward {
        return Err("There's no page to go forward to.".into());
    }
    let _driving = browsers.drive(&app, &id, ctx.chat_id.as_deref());
    let before = browsers.generation(&id);
    browsers.go(&id, go)?;
    browsers.settled(&id, before, Duration::from_secs(2), LOAD_WAIT).await;
    Ok(report(&app, &id).await)
}

async fn close(app: AppHandle, ctx: Ctx, raw: Value) -> Result<Value, String> {
    let TabArgs { tab_id } = args(raw)?;
    let id = tab_of(&app, &ctx, tab_id)?;
    browsers(&app)?.close(&app, &id);
    Ok(json!(format!("Closed tab {id}.")))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResizeArgs {
    #[serde(default)]
    width: Option<u32>,
    #[serde(default)]
    height: Option<u32>,
    #[serde(default)]
    preset: Option<String>,
    #[serde(default)]
    tab_id: Option<String>,
}

async fn resize(app: AppHandle, ctx: Ctx, raw: Value) -> Result<Value, String> {
    let ResizeArgs { width, height, preset, tab_id } = args(raw)?;
    let id = tab_of(&app, &ctx, tab_id)?;
    let viewport = match (preset.as_deref(), width, height) {
        (Some("fit"), ..) => None,
        (Some("phone"), ..) => Some(Viewport { width: 390, height: 844 }),
        (Some("tablet"), ..) => Some(Viewport { width: 820, height: 1180 }),
        (Some("desktop"), ..) => Some(Viewport { width: 1440, height: 900 }),
        (Some(other), ..) => return Err(format!("There's no preset {other}: phone, tablet, desktop or fit.")),
        (None, Some(width), Some(height)) => Some(Viewport {
            width: width.clamp(200, 3840),
            height: height.clamp(200, 2160),
        }),
        (None, ..) => return Err("Give a width and a height, or a preset.".into()),
    };
    let browsers = browsers(&app)?;
    let _driving = browsers.drive(&app, &id, ctx.chat_id.as_deref());
    browsers.set_viewport(&app, &id, viewport)?;
    // The page lays a tab on screen out again; give it a moment.
    tokio::time::sleep(Duration::from_millis(300)).await;
    Ok(report(&app, &id).await)
}

async fn tabs(app: AppHandle, ctx: Ctx, _raw: Value) -> Result<Value, String> {
    let browsers = browsers(&app)?;
    let default = browsers.default_tab(ctx.chat_id.as_deref());
    let tabs: Vec<Value> = browsers
        .list()
        .into_iter()
        .map(|tab| {
            json!({
                "tabId": tab.id,
                "url": tab.url,
                "title": tab.title,
                "loading": tab.loading,
                "onScreen": browsers.is_shown(&tab.id),
                "yours": default.as_deref() == Some(tab.id.as_str()),
            })
        })
        .collect();
    Ok(json!({ "tabs": tabs }))
}

async fn status(app: AppHandle, ctx: Ctx, raw: Value) -> Result<Value, String> {
    let TabArgs { tab_id } = args(raw)?;
    let id = tab_of(&app, &ctx, tab_id)?;
    Ok(report(&app, &id).await)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotArgs {
    #[serde(default)]
    selector: Option<String>,
    #[serde(default)]
    tab_id: Option<String>,
}

async fn snapshot(app: AppHandle, ctx: Ctx, raw: Value) -> Result<Value, String> {
    let SnapshotArgs { selector, tab_id } = args(raw)?;
    let id = tab_of(&app, &ctx, tab_id)?;
    let browsers = browsers(&app)?;
    let _driving = browsers.drive(&app, &id, ctx.chat_id.as_deref());
    let body = format!("return window.__outcode.snapshot({});", lit(&selector));
    let outline = browsers.js(&id, &body, Duration::from_secs(20)).await.map_err(JsError::message)?;
    let info = browsers.info(&id).ok_or("That tab closed.")?;
    Ok(json!(format!(
        "Tab {id}: {}\n{}\n\n{}",
        if info.title.is_empty() { "(untitled)" } else { &info.title },
        info.url,
        outline.as_str().unwrap_or_default()
    )))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScreenshotArgs {
    #[serde(default)]
    full_page: bool,
    #[serde(default)]
    tab_id: Option<String>,
}

async fn screenshot(app: AppHandle, ctx: Ctx, raw: Value) -> Result<Value, String> {
    let ScreenshotArgs { full_page, tab_id } = args(raw)?;
    let id = tab_of(&app, &ctx, tab_id)?;
    if !SCREENSHOTS {
        return Err("Screenshots of browser tabs aren't supported on this platform yet: read the page with browser_snapshot.".into());
    }
    let browsers = browsers(&app)?;
    let _driving = browsers.drive(&app, &id, ctx.chat_id.as_deref());
    // A long page as JPEG: a PNG of it runs to megabytes.
    let mut shot = Shot { full_page, jpeg: full_page, ..Shot::default() };
    // A page scaled down to fit the panel is pictured at its real size.
    let zoom = browsers.zoom(&id);
    if zoom < 0.99 {
        shot.scale = Some((1.0 / zoom).min(4.0));
        if !full_page {
            let page = browsers.js(&id, "return window.__outcode.status();", Duration::from_secs(5)).await.map_err(JsError::message)?;
            let number = |a: &str, b: &str| page[a][b].as_f64().unwrap_or(0.0);
            shot.clip = Some(Clip {
                x: number("scroll", "x"),
                y: number("scroll", "y"),
                width: number("viewport", "width"),
                height: number("viewport", "height"),
            });
        }
    }
    let picture = browsers.screenshot(&id, shot).await?;
    let (name, mime) = if full_page { ("screenshot.jpg", "image/jpeg") } else { ("screenshot.png", "image/png") };
    let attachment = super::engine(&app)?.store().save_attachment(name, &picture).map_err(|e| e.to_string())?;
    let info = browsers.info(&id).ok_or("That tab closed.")?;
    let mut out = json!({
        "tabId": id,
        "url": info.url,
        "file": attachment.path,
        "attachment": attachment,
        "caption": if info.title.is_empty() { info.url } else { info.title },
    });
    out[IMAGES_KEY] = json!([{ "data": base64::engine::general_purpose::STANDARD.encode(&picture), "mimeType": mime }]);
    Ok(out)
}

/// Runs one of the page helpers' actions and waits out a page load it started.
async fn act(app: &AppHandle, ctx: &Ctx, id: &str, body: &str) -> Result<Value, String> {
    let browsers = browsers(app)?;
    let _driving = browsers.drive(app, id, ctx.chat_id.as_deref());
    let before = browsers.generation(id);
    let before_url = browsers.info(id).map(|t| t.url).unwrap_or_default();
    let tabs_before: Vec<String> = browsers.list().into_iter().map(|t| t.id).collect();
    let (mut did, mut note) = (String::new(), None);
    match browsers.js(id, body, Duration::from_secs(15)).await {
        Ok(result) => {
            did = result["did"].as_str().unwrap_or("Done").to_owned();
            note = result["covered"].as_str().map(|by| format!("{by} is drawn over it there, so the click may not have landed."));
        }
        // The action itself took the page away: it worked.
        Err(JsError::Navigated) => {}
        Err(e) => return Err(e.message()),
    }
    browsers.settled(id, before, ACTION_GRACE, ACTION_LOAD_WAIT).await;
    // A tab the action opened (a link to a new window): the page's own doing,
    // and where this chat's next calls go.
    let opened = browsers.list().into_iter().rfind(|t| !tabs_before.contains(&t.id));
    let opened = match opened {
        Some(tab) => {
            browsers.settled(&tab.id, 0, LOAD_WAIT, LOAD_WAIT).await;
            browsers.info(&tab.id)
        }
        None => None,
    };
    let info = browsers.info(id).ok_or("The tab closed.")?;
    if did.is_empty() {
        did = "Done; the page navigated".into();
    }
    let mut out = json!({ "did": did, "url": info.url, "title": info.title });
    if info.url != before_url {
        out["navigated"] = json!(true);
    }
    if let Some(note) = note {
        out["note"] = json!(note);
    }
    if let Some(tab) = opened {
        out["openedTab"] = json!({ "tabId": tab.id, "url": tab.url, "title": tab.title });
        out["note"] = json!("It opened a new tab, which your next calls use.");
    }
    Ok(out)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClickArgs {
    target: String,
    #[serde(default)]
    button: Option<String>,
    #[serde(default)]
    double: bool,
    #[serde(default)]
    tab_id: Option<String>,
}

async fn click(app: AppHandle, ctx: Ctx, raw: Value) -> Result<Value, String> {
    let ClickArgs { target, button, double, tab_id } = args(raw)?;
    let id = tab_of(&app, &ctx, tab_id)?;
    let options = json!({ "button": button, "double": double });
    act(&app, &ctx, &id, &format!("return window.__outcode.click({}, {options});", lit(&target))).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TargetArgs {
    target: String,
    #[serde(default)]
    tab_id: Option<String>,
}

async fn hover(app: AppHandle, ctx: Ctx, raw: Value) -> Result<Value, String> {
    let TargetArgs { target, tab_id } = args(raw)?;
    let id = tab_of(&app, &ctx, tab_id)?;
    act(&app, &ctx, &id, &format!("return window.__outcode.hover({});", lit(&target))).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TypeArgs {
    target: String,
    text: String,
    #[serde(default)]
    append: bool,
    #[serde(default)]
    submit: bool,
    #[serde(default)]
    tab_id: Option<String>,
}

async fn type_text(app: AppHandle, ctx: Ctx, raw: Value) -> Result<Value, String> {
    let TypeArgs { target, text, append, submit, tab_id } = args(raw)?;
    let id = tab_of(&app, &ctx, tab_id)?;
    let options = json!({ "append": append, "submit": submit });
    let body = format!("return window.__outcode.type({}, {}, {options});", lit(&target), lit(&text));
    act(&app, &ctx, &id, &body).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct KeyArgs {
    key: String,
    #[serde(default)]
    target: Option<String>,
    #[serde(default)]
    tab_id: Option<String>,
}

async fn press_key(app: AppHandle, ctx: Ctx, raw: Value) -> Result<Value, String> {
    let KeyArgs { key, target, tab_id } = args(raw)?;
    let id = tab_of(&app, &ctx, tab_id)?;
    let target = target.filter(|t| !t.trim().is_empty());
    act(&app, &ctx, &id, &format!("return window.__outcode.press({}, {});", lit(&key), lit(&target))).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WaitArgs {
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    selector: Option<String>,
    #[serde(default)]
    gone: bool,
    #[serde(default)]
    timeout_sec: Option<u64>,
    #[serde(default)]
    tab_id: Option<String>,
}

async fn wait_for(app: AppHandle, ctx: Ctx, raw: Value) -> Result<Value, String> {
    let WaitArgs { text, selector, gone, timeout_sec, tab_id } = args(raw)?;
    let id = tab_of(&app, &ctx, tab_id)?;
    let text = text.filter(|t| !t.is_empty());
    let selector = selector.filter(|s| !s.trim().is_empty());
    if text.is_none() && selector.is_none() {
        return Err("Say what to wait for: text, a selector, or both.".into());
    }
    let browsers = browsers(&app)?;
    let _driving = browsers.drive(&app, &id, ctx.chat_id.as_deref());
    let limit = Duration::from_secs(timeout_sec.unwrap_or(WAIT_FOR).clamp(1, MAX_WAIT_FOR));
    let what = json!({ "text": text, "selector": selector, "gone": gone });
    let started = std::time::Instant::now();
    loop {
        let left = limit.saturating_sub(started.elapsed());
        let body = format!("return await window.__outcode.waitFor({what}, {});", left.as_millis());
        match browsers.js(&id, &body, left + Duration::from_secs(5)).await {
            Ok(_) => {
                let info = browsers.info(&id).ok_or("The tab closed.")?;
                return Ok(json!({ "waitedMs": started.elapsed().as_millis() as u64, "url": info.url, "title": info.title }));
            }
            // A page load in between: keep waiting on the new page.
            Err(JsError::Navigated) if !left.is_zero() => tokio::time::sleep(Duration::from_millis(150)).await,
            Err(JsError::Failed(e)) if e == "timeout" => break,
            Err(JsError::Navigated) => break,
            Err(e) => return Err(e.message()),
        }
    }
    let what = match (&text, &selector) {
        (Some(text), Some(selector)) => format!("{selector} with \"{text}\""),
        (Some(text), None) => format!("\"{text}\""),
        (None, Some(selector)) => selector.clone(),
        (None, None) => String::new(),
    };
    Err(format!(
        "{what} {} after {} s. browser_snapshot shows what the page has now.",
        if gone { "was still there" } else { "didn't show up" },
        limit.as_secs()
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LogArgs {
    #[serde(default)]
    level: Option<String>,
    #[serde(default)]
    limit: Option<u32>,
    #[serde(default)]
    clear: bool,
    #[serde(default)]
    tab_id: Option<String>,
}

async fn logs(app: AppHandle, ctx: Ctx, raw: Value) -> Result<Value, String> {
    let LogArgs { level, limit, clear, tab_id } = args(raw)?;
    let id = tab_of(&app, &ctx, tab_id)?;
    let levels: &[&str] = match level.as_deref() {
        Some("errors") => &["error", "network"],
        Some("warnings") => &["error", "network", "warn"],
        _ => &[],
    };
    let options = json!({ "levels": levels, "limit": limit.unwrap_or(100).clamp(1, 500), "clear": clear });
    let read = browsers(&app)?
        .js(&id, &format!("return window.__outcode.logs({options});"), Duration::from_secs(10))
        .await
        .map_err(JsError::message)?;
    let entries = read["entries"].as_array().cloned().unwrap_or_default();
    if entries.is_empty() {
        return Ok(json!("Nothing logged on this page."));
    }
    let mut out = String::new();
    let total = read["total"].as_u64().unwrap_or(0) as usize;
    if total > entries.len() {
        out.push_str(&format!("(the latest {} of {total})\n", entries.len()));
    }
    for entry in &entries {
        let millis = entry["time"].as_u64().unwrap_or(0);
        let (h, m, s) = ((millis / 3_600_000) % 24, (millis / 60_000) % 60, (millis / 1000) % 60);
        out.push_str(&format!(
            "{h:02}:{m:02}:{s:02}Z [{}] {}\n",
            entry["level"].as_str().unwrap_or("log"),
            entry["text"].as_str().unwrap_or_default()
        ));
    }
    Ok(json!(clip(out)))
}

/// A result cut to what a tool call should carry.
fn clip(mut text: String) -> String {
    if text.len() > MAX_RESULT {
        let mut end = MAX_RESULT;
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        text.truncate(end);
        text.push_str("\n… (cut short)");
    }
    text
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RunArgs {
    code: String,
    #[serde(default)]
    timeout_sec: Option<u64>,
    #[serde(default)]
    tab_id: Option<String>,
}

async fn run(app: AppHandle, ctx: Ctx, raw: Value) -> Result<Value, String> {
    let RunArgs { code, timeout_sec, tab_id } = args(raw)?;
    needs_trust(&app, &ctx, "browser_run")?;
    let id = tab_of(&app, &ctx, tab_id)?;
    let browsers = browsers(&app)?;
    let _driving = browsers.drive(&app, &id, ctx.chat_id.as_deref());
    let limit = Duration::from_secs(timeout_sec.unwrap_or(RUN_WAIT).clamp(1, MAX_RUN_WAIT));
    // As an expression first, so `document.title` gives its value; code that
    // isn't one doesn't parse that way (nothing runs), and goes as statements.
    let expression = code.trim().trim_end_matches(';').trim_end();
    let result = match browsers.js(&id, &format!("return (\n{expression}\n);"), limit).await {
        Err(JsError::Syntax) => browsers.js(&id, &code, limit).await,
        other => other,
    };
    match result {
        Ok(Value::String(text)) => Ok(json!(clip(text))),
        Ok(value) => {
            let text = serde_json::to_string_pretty(&value).unwrap_or_default();
            if text.len() > MAX_RESULT { Ok(json!(clip(text))) } else { Ok(json!({ "result": value })) }
        }
        Err(JsError::Navigated) => Ok(json!("The page navigated away while it ran; no result.")),
        Err(e) => Err(e.message()),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UploadArgs {
    target: String,
    paths: Vec<String>,
    #[serde(default)]
    tab_id: Option<String>,
}

fn mime_of(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).as_deref() {
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("svg") => "image/svg+xml",
        Some("pdf") => "application/pdf",
        Some("json") => "application/json",
        Some("csv") => "text/csv",
        Some("txt" | "md" | "log") => "text/plain",
        Some("html" | "htm") => "text/html",
        Some("zip") => "application/zip",
        _ => "application/octet-stream",
    }
}

async fn upload(app: AppHandle, ctx: Ctx, raw: Value) -> Result<Value, String> {
    let UploadArgs { target, paths, tab_id } = args(raw)?;
    needs_trust(&app, &ctx, "browser_upload")?;
    let chat = calling_chat(&app, &ctx)?;
    let id = tab_of(&app, &ctx, tab_id)?;
    let mut files = Vec::new();
    let mut total = 0;
    for path in &paths {
        let mut file = PathBuf::from(path.trim());
        if file.is_relative() {
            file = Path::new(chat.work_dir()).join(file);
        }
        let meta = tokio::fs::metadata(&file).await.map_err(|e| format!("{}: {e}", file.display()))?;
        total += meta.len();
        if !meta.is_file() || total > MAX_UPLOAD {
            return Err(format!("{} isn't a file, or the files come to more than 24 MB.", file.display()));
        }
        let bytes = tokio::fs::read(&file).await.map_err(|e| format!("{}: {e}", file.display()))?;
        files.push(json!({
            "name": file.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "file".into()),
            "type": mime_of(&file),
            "data": base64::engine::general_purpose::STANDARD.encode(bytes),
        }));
    }
    let body = format!("return window.__outcode.upload({}, {});", lit(&target), Value::Array(files));
    act(&app, &ctx, &id, &body).await
}
