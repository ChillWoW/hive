//! HTML pages agents show in the chat, as t3code's `html_preview` /
//! `html_render`: `preview_html` loads a page in a hidden frame of the
//! window (`src/htmlpage`) and reports what happened (height, console,
//! errors, text); `render_html` saves it as an attachment, which the
//! transcript shows where the call is, in a sandboxed frame whose scripts run.
//!
//! Both get the page prepared here: Hive's theme as CSS variables, local
//! images (absolute paths) inlined as data URLs, viewport heights refused
//! (the frame follows the page's height, so they'd grow it forever).

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use base64::Engine as _;
use hive_engine::Engine;
use hive_mcp::Ctx;
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::oneshot;

pub const PREVIEW_TOOL: &str = "preview_html";
pub const RENDER_TOOL: &str = "render_html";

/// The longest page an agent may send, in bytes.
const MAX_HTML: usize = 512_000;
/// The prepared page, images inlined.
const MAX_PAGE: usize = 25 * 1024 * 1024;
const MAX_IMAGE: u64 = 10 * 1024 * 1024;
const MAX_TITLE: usize = 200;
/// The transcript's width (`max-w-3xl`).
const DEFAULT_WIDTH: u32 = 768;
const MIN_WIDTH: u32 = 240;
const MAX_WIDTH: u32 = 1600;
const MIN_HEIGHT: u32 = 80;
const MAX_HEIGHT: u32 = 1600;
/// How long `preview_html` waits for the window's report.
const CHECK_WAIT: Duration = Duration::from_secs(30);
/// The event the window checks pages on (`src/htmlpage/check.ts`).
const CHECK_EVENT: &str = "html://check";

const PAGE_RULES: &str = "Send one self-contained HTML document: inline <style> and <script>; scripts, styles and fonts from https CDNs load as they are. Local images given as absolute paths (src=\"/abs/chart.png\", url('C:/img/a.png')) are inlined; relative URLs don't resolve. Scripts run sandboxed: no access to Hive, cookies or storage (localStorage throws), network requests work.";

const LAYOUT_GUIDE: &str = "The frame is as wide as the reply (768px, less in a narrow window) and grows to the page's height (up to 1600px, then the page scrolls). Hive draws the page straight onto the chat: leave html and body without a background, margin, outer card, border or page title. Give charts and canvases fixed pixel heights. Never use viewport heights (vh, dvh, svh, lvh) or height:100% on html or body: the frame follows the page's height, so those grow it again and again (vh units are refused).";

const THEME_GUIDE: &str = "Hive's dark theme is set as CSS variables; use them rather than fixed colours: --background, --foreground, --muted, --muted-foreground, --card, --border, --primary, --primary-foreground, --danger, --success, --warning, --info, --chart-1 to --chart-6, --radius, --font-sans, --font-mono. Text defaults to 14px --font-sans in --foreground.";

pub fn preview_description() -> String {
    format!(
        "Check an HTML page before render_html. Hive loads it in a hidden frame as wide as the chat and returns its contentHeight, console output, uncaught errors and failed loads, and the start of its visible text. Fix what it reports, then call render_html. {PAGE_RULES} Layout and theme rules are in render_html."
    )
}

pub fn render_description() -> String {
    format!(
        "Show a finished HTML page (an interactive chart, diagram, dashboard, mockup or small tool) inline in this Hive chat, where you call it, above your reply; its JavaScript runs. Use it when a live page says more than prose, after checking it with preview_html. The user already sees it, so don't announce, locate or restate it. {PAGE_RULES} {LAYOUT_GUIDE} {THEME_GUIDE}"
    )
}

fn html_property() -> Value {
    json!({
        "type": "string",
        "description": "A complete, self-contained HTML document."
    })
}

pub fn preview_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "html": html_property(),
            "width": {
                "type": "integer",
                "minimum": MIN_WIDTH,
                "maximum": MAX_WIDTH,
                "description": "Frame width in CSS pixels. Default 768, the chat's width; about 390 for a phone."
            }
        },
        "required": ["html"],
        "additionalProperties": false
    })
}

pub fn render_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "html": html_property(),
            "title": {
                "type": "string",
                "description": "A short name for the page, e.g. \"Latency by region\"."
            },
            "height": {
                "type": "integer",
                "minimum": MIN_HEIGHT,
                "maximum": MAX_HEIGHT,
                "description": "Frame height in CSS pixels until the page reports its own: the contentHeight from preview_html."
            }
        },
        "required": ["html", "title"],
        "additionalProperties": false
    })
}

#[derive(Deserialize)]
struct PreviewArgs {
    html: String,
    #[serde(default)]
    width: Option<u32>,
}

#[derive(Deserialize)]
struct RenderArgs {
    html: String,
    title: String,
    #[serde(default)]
    height: Option<u32>,
}

/// The pages the window is checking, by id.
#[derive(Default)]
pub struct HtmlChecks {
    pending: Mutex<HashMap<String, oneshot::Sender<Value>>>,
}

impl HtmlChecks {
    fn pending(&self) -> MutexGuard<'_, HashMap<String, oneshot::Sender<Value>>> {
        self.pending.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// `preview_html`: the window loads the page and reports on it.
pub async fn preview(app: AppHandle, args: Value) -> Result<Value, String> {
    let args: PreviewArgs =
        serde_json::from_value(args).map_err(|e| format!("Bad arguments: {e}"))?;
    let width = args
        .width
        .unwrap_or(DEFAULT_WIDTH)
        .clamp(MIN_WIDTH, MAX_WIDTH);
    let page = prepare(&args.html)?;

    let checks = Arc::clone(app.state::<Arc<HtmlChecks>>().inner());
    let id = uuid::Uuid::new_v4().simple().to_string();
    let (reply, report) = oneshot::channel();
    checks.pending().insert(id.clone(), reply);
    if let Err(e) = app.emit(
        CHECK_EVENT,
        json!({ "id": id, "html": page.html, "width": width }),
    ) {
        checks.pending().remove(&id);
        return Err(format!("Couldn't reach Hive's window: {e}"));
    }
    let report = tokio::time::timeout(CHECK_WAIT, report).await;
    checks.pending().remove(&id);
    let Ok(Ok(Value::Object(mut report))) = report else {
        return Err("Hive's window didn't check the page in time. Try again.".into());
    };
    report.insert("width".into(), width.into());
    if !page.missing.is_empty() {
        report.insert("missingImages".into(), page.missing.into());
    }
    Ok(Value::Object(report))
}

/// `render_html`: saves the page as an attachment; the transcript reads the
/// call's result to show it.
pub async fn render(app: AppHandle, ctx: Ctx, args: Value) -> Result<Value, String> {
    ctx.chat_id.ok_or("This session isn't a Hive chat.")?;
    let args: RenderArgs =
        serde_json::from_value(args).map_err(|e| format!("Bad arguments: {e}"))?;
    let title = args.title.trim();
    if title.is_empty() {
        return Err("`title` can't be empty.".into());
    }
    if title.chars().count() > MAX_TITLE {
        return Err(format!("`title` is over {MAX_TITLE} characters."));
    }
    let page = prepare(&args.html)?;
    if !page.missing.is_empty() {
        return Err(format!(
            "These local images couldn't be read as images: {}. Use absolute paths to existing image files (PNG, JPEG, GIF, WebP, SVG, AVIF, BMP, ICO; 10 MB at most), or remove them.",
            page.missing.join(", ")
        ));
    }
    let engine = app
        .try_state::<Engine>()
        .ok_or("Hive is still starting.")?
        .inner()
        .clone();
    let name = format!("{}.html", file_stem(title));
    let saved = tokio::task::spawn_blocking(move || {
        engine.store().attachments().save(&name, page.html.as_bytes())
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| format!("Couldn't save the page: {e}"))?;
    Ok(json!({
        "page": {
            "file": saved.path,
            "title": title,
            "height": args.height.map(|h| h.clamp(MIN_HEIGHT, MAX_HEIGHT)),
        },
        "message": "Shown to the user above your reply. Don't mention or describe the page; reply with only what it doesn't already say.",
    }))
}

/// The window's report on a page it checked.
#[tauri::command]
pub fn answer_html_check(checks: State<'_, Arc<HtmlChecks>>, id: String, report: Value) {
    if let Some(reply) = checks.pending().remove(&id) {
        let _ = reply.send(report);
    }
}

struct Prepared {
    html: String,
    /// Local images that couldn't be inlined.
    missing: Vec<String>,
}

fn prepare(html: &str) -> Result<Prepared, String> {
    if html.trim().is_empty() {
        return Err("`html` is empty.".into());
    }
    if html.len() > MAX_HTML {
        return Err(format!(
            "The page is {} KB; {} KB at most. Load big libraries from a CDN.",
            html.len() / 1000,
            MAX_HTML / 1000
        ));
    }
    if let Some(unit) = viewport_unit(html) {
        return Err(format!(
            "The page uses a viewport height ({unit}). The frame grows to fit the page, so a size that follows the viewport grows it again and again. Use fixed pixel heights instead."
        ));
    }
    let (inlined, missing) = inline_images(html);
    let html = with_theme(&inlined);
    if html.len() > MAX_PAGE {
        return Err(format!(
            "With its images inlined the page is {} MB; {} MB at most.",
            html.len() / 1024 / 1024,
            MAX_PAGE / 1024 / 1024
        ));
    }
    Ok(Prepared { html, missing })
}

/// Hive's theme, first in the head so the page's own styles win.
const THEME_STYLE: &str = r#"<style id="hive-theme">
:root {
  color-scheme: dark;
  --background: #141414;
  --foreground: #c9c9c9;
  --muted: #1f1f1f;
  --muted-foreground: #828282;
  --card: rgb(255 255 255 / 0.035);
  --border: #2e2e2e;
  --primary: #f3f4f6;
  --primary-foreground: #141414;
  --danger: #ff616e;
  --success: #a5e075;
  --warning: #f0a45d;
  --info: #6fb3f2;
  --chart-1: #6fb3f2;
  --chart-2: #a5e075;
  --chart-3: #f0a45d;
  --chart-4: #c49cf2;
  --chart-5: #5fd4c4;
  --chart-6: #ff616e;
  --radius: 6px;
  --font-sans: system-ui, sans-serif;
  --font-mono: ui-monospace, "Cascadia Code", Menlo, Consolas, monospace;
}
html { background: transparent; color: var(--foreground); font: 14px/1.5 var(--font-sans); -webkit-font-smoothing: antialiased; }
body { margin: 0; }
</style>"#;

/// The page with [`THEME_STYLE`] at the start of its head, keeping a doctype
/// first (without one the page would render in quirks mode).
fn with_theme(html: &str) -> String {
    let lower = html.to_ascii_lowercase();
    let at = if let Some(head) = lower.find("<head") {
        lower[head..].find('>').map(|end| head + end + 1)
    } else if let Some(doctype) = lower.find("<!doctype") {
        lower[doctype..].find('>').map(|end| doctype + end + 1)
    } else {
        None
    };
    match at {
        Some(at) => format!("{}{THEME_STYLE}{}", &html[..at], &html[at..]),
        None => format!("<!doctype html>{THEME_STYLE}{html}"),
    }
}

/// The first viewport height (`100vh`, `50dvh`, …) outside scripts.
fn viewport_unit(html: &str) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    let bytes = lower.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        // Bytes, not `str` slices: `i` may be inside a multi-byte character.
        if bytes[i..].starts_with(b"<script") {
            let end = bytes[i..].windows(8).position(|w| w == b"</script")?;
            i += end + "</script".len();
            continue;
        }
        let starts_number = bytes[i].is_ascii_digit()
            && (i == 0 || !(bytes[i - 1].is_ascii_alphanumeric() || bytes[i - 1] == b'_'));
        if starts_number {
            let start = i;
            while i < bytes.len() && (bytes[i].is_ascii_digit() || bytes[i] == b'.') {
                i += 1;
            }
            let unit_start = i;
            while i < bytes.len() && bytes[i].is_ascii_alphabetic() {
                i += 1;
            }
            if matches!(&lower[unit_start..i], "vh" | "dvh" | "svh" | "lvh") {
                return Some(html[start..i].to_owned());
            }
            continue;
        }
        i += 1;
    }
    None
}

/// Quoted values and `url(…)`s naming a local image by absolute path, read
/// in as data URLs. Returns the page and the paths that couldn't be.
fn inline_images(html: &str) -> (String, Vec<String>) {
    let mut out = String::with_capacity(html.len());
    let mut missing: Vec<String> = Vec::new();
    let mut rest = html;
    while let Some(i) = rest.find(['"', '\'', '(']) {
        let close = match rest.as_bytes()[i] {
            b'(' => ')',
            b => b as char,
        };
        out.push_str(&rest[..=i]);
        rest = &rest[i + 1..];
        let Some(end) = rest.find(close) else {
            continue;
        };
        let raw = &rest[..end];
        let Some(path) = local_image(raw.trim().trim_matches(['"', '\''])) else {
            continue;
        };
        match data_url(&path) {
            Some(url) => {
                out.push_str(&url);
                rest = &rest[end..];
            }
            None => {
                if !missing.contains(&path) {
                    missing.push(path);
                }
            }
        }
    }
    out.push_str(rest);
    (out, missing)
}

const IMAGE_EXTENSIONS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "bmp", "ico",
];

/// `value` as an absolute path to an image file (by its extension), with a
/// `file://` scheme dropped.
fn local_image(value: &str) -> Option<String> {
    if value.is_empty() || value.len() > 1024 || value.contains(['\n', '<', '>']) {
        return None;
    }
    let path = match value.strip_prefix("file://") {
        // `file:///C:/x.png` → `C:/x.png`; `file:///home/x.png` → `/home/x.png`.
        Some(rest) => {
            let rest = rest.replace("%20", " ");
            let bytes = rest.as_bytes();
            if bytes.len() > 3 && bytes[0] == b'/' && bytes[2] == b':' {
                rest[1..].to_owned()
            } else {
                rest
            }
        }
        None => value.to_owned(),
    };
    if path.starts_with("//") || !Path::new(&path).is_absolute() {
        return None;
    }
    let ext = Path::new(&path)
        .extension()?
        .to_string_lossy()
        .to_ascii_lowercase();
    IMAGE_EXTENSIONS.contains(&ext.as_str()).then_some(path)
}

/// The image at `path` as a data URL, typed by its bytes (so a renamed file
/// that isn't an image is never inlined).
fn data_url(path: &str) -> Option<String> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > MAX_IMAGE {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    let mime = image_type(&bytes)?;
    Some(format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(&bytes)
    ))
}

fn image_type(bytes: &[u8]) -> Option<&'static str> {
    Some(match bytes {
        [0x89, b'P', b'N', b'G', ..] => "image/png",
        [0xFF, 0xD8, 0xFF, ..] => "image/jpeg",
        [b'G', b'I', b'F', b'8', ..] => "image/gif",
        [b'R', b'I', b'F', b'F', _, _, _, _, b'W', b'E', b'B', b'P', ..] => "image/webp",
        [_, _, _, _, b'f', b't', b'y', b'p', b'a', b'v', b'i', b'f', ..] => "image/avif",
        [b'B', b'M', ..] => "image/bmp",
        [0, 0, 1, 0, ..] => "image/x-icon",
        _ => {
            let head = std::str::from_utf8(&bytes[..bytes.len().min(1024)]).ok()?;
            let head = head.trim_start_matches('\u{feff}').trim_start();
            if head.starts_with("<svg") || (head.starts_with("<?xml") && head.contains("<svg")) {
                "image/svg+xml"
            } else {
                return None;
            }
        }
    })
}

/// A file name for the page: its title, kept to safe characters.
fn file_stem(title: &str) -> String {
    let stem: String = title
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect();
    let stem = stem
        .split('-')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    let stem: String = stem.chars().take(60).collect();
    if stem.is_empty() {
        "page".into()
    } else {
        stem
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_theme_goes_into_the_head_after_the_doctype() {
        let page = with_theme("<!DOCTYPE html><html><head><title>x</title></head></html>");
        assert!(page.starts_with("<!DOCTYPE html><html><head><style id=\"hive-theme\">"));
        let page = with_theme("<!doctype html><body>hi</body>");
        assert!(page.starts_with("<!doctype html><style id=\"hive-theme\">"));
        let page = with_theme("<div>hi</div>");
        assert!(page.starts_with("<!doctype html><style"));
        assert!(page.ends_with("<div>hi</div>"));
    }

    #[test]
    fn viewport_heights_are_found_outside_scripts() {
        assert_eq!(viewport_unit("<style>body{min-height:100vh}</style>").as_deref(), Some("100vh"));
        assert_eq!(viewport_unit("<div style=\"height: 50.5DVH\">").as_deref(), Some("50.5DVH"));
        assert_eq!(viewport_unit("<script>el.style.height='100vh'</script><p>10px</p>"), None);
        assert_eq!(viewport_unit("<p>h1vh 10vw 2vmin</p>"), None);
        assert_eq!(viewport_unit("<p>€ 5 → é</p><i style=\"top:3svh\">").as_deref(), Some("3svh"));
    }

    #[test]
    fn local_images_are_inlined_and_missing_ones_reported() {
        let dir = tempfile::tempdir().unwrap();
        let png = dir.path().join("a b.png");
        std::fs::write(&png, b"\x89PNG\r\n\x1a\n").unwrap();
        let fake = dir.path().join("secret.png");
        std::fs::write(&fake, b"password").unwrap();
        let png = png.display().to_string();
        let fake = fake.display().to_string();
        let html = format!(
            "<img src=\"{png}\"><div style=\"background:url('{png}')\"></div><img src='{fake}'><p>don't (touch) this</p><img src=\"https://x.dev/a.png\">"
        );
        let (out, missing) = inline_images(&html);
        assert_eq!(out.matches("data:image/png;base64,").count(), 2);
        assert!(!out.contains(&png));
        assert!(out.contains("<p>don't (touch) this</p>"));
        assert!(out.contains("https://x.dev/a.png"));
        assert_eq!(missing, vec![fake]);
    }

    #[test]
    fn titles_make_safe_file_names() {
        assert_eq!(file_stem("Latency by region (p95)"), "Latency-by-region-p95");
        assert_eq!(file_stem("???"), "page");
    }
}
