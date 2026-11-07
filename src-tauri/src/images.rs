//! Images agents show in the chat: `show_image` (a file on disk) and
//! `show_svg` (markup). Each is copied into Hive's attachments; the
//! transcript reads the call's result and draws it where the call is, as an
//! `<img>` (an SVG's scripts and external loads never run there).

use std::path::{Path, PathBuf};

use hive_mcp::Ctx;
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::AppHandle;

use crate::mcp;
use crate::util::{blocking, image_type};

pub const IMAGE_TOOL: &str = "show_image";
pub const SVG_TOOL: &str = "show_svg";

const MAX_IMAGE: u64 = 20 * 1024 * 1024;
const MAX_SVG: usize = 2 * 1024 * 1024;
const MAX_CAPTION: usize = 300;

const SHOWN: &str = "Shown to the user above your reply. Don't mention or describe the image; reply with only what it doesn't already say.";

const BACKGROUND_GUIDE: &str = "It's drawn straight onto Hive's dark chat (#141414): transparent areas show that, so dark strokes and text vanish. Pass background \"light\" to put it on a white card instead.";

pub fn image_description() -> String {
    format!(
        "Show an image file (PNG, JPEG, GIF, WebP, AVIF, BMP, ICO or SVG; 20 MB at most) inline in this Hive chat, where you call it, above your reply: a screenshot, a rendered plot, a generated picture. Hive keeps a copy, so the file may change or go afterwards. Call it once per image. {BACKGROUND_GUIDE}"
    )
}

pub fn svg_description() -> String {
    format!(
        "Show an SVG you write (a diagram, icon, sketch or simple chart) inline in this Hive chat, where you call it, above your reply. It's drawn as an image: no scripts, no external fonts or images, no CSS variables from Hive; inline everything. Give the root <svg> a viewBox and a width (and height) in pixels; it's shown at that size, scaled down to fit the reply (768px wide, 640px tall at most). {BACKGROUND_GUIDE} Light colours that read on dark: #c9c9c9 text, #6fb3f2 blue, #a5e075 green, #f0a45d orange, #c49cf2 purple, #ff616e red, #2e2e2e lines. For anything interactive use render_html instead."
    )
}

fn shared_properties() -> Value {
    json!({
        "caption": {
            "type": "string",
            "description": "A short line shown under the image."
        },
        "background": {
            "type": "string",
            "enum": ["none", "light"],
            "description": "\"none\" (default): on the dark chat. \"light\": on a white card."
        }
    })
}

pub fn image_schema() -> Value {
    let mut properties = shared_properties();
    properties["path"] = json!({
        "type": "string",
        "description": "The image file: an absolute path, or one relative to the chat's folder."
    });
    json!({
        "type": "object",
        "properties": properties,
        "required": ["path"],
        "additionalProperties": false
    })
}

pub fn svg_schema() -> Value {
    let mut properties = shared_properties();
    properties["svg"] = json!({
        "type": "string",
        "description": "The SVG document, starting with <svg (or <?xml)."
    });
    properties["title"] = json!({
        "type": "string",
        "description": "A short name, used for the saved file, e.g. \"Request flow\"."
    });
    json!({
        "type": "object",
        "properties": properties,
        "required": ["svg"],
        "additionalProperties": false
    })
}

#[derive(Deserialize)]
struct Shared {
    #[serde(default)]
    caption: Option<String>,
    #[serde(default)]
    background: Option<String>,
}

#[derive(Deserialize)]
struct ImageArgs {
    path: String,
    #[serde(flatten)]
    shared: Shared,
}

#[derive(Deserialize)]
struct SvgArgs {
    svg: String,
    #[serde(default)]
    title: Option<String>,
    #[serde(flatten)]
    shared: Shared,
}

/// `show_image`: copies the file in.
pub async fn show_image(app: AppHandle, ctx: Ctx, args: Value) -> Result<Value, String> {
    let chat = mcp::calling_chat(&app, &ctx)?;
    let args: ImageArgs = mcp::args(args)?;
    let (caption, background) = shared(args.shared)?;
    let raw = args.path.trim();
    if raw.is_empty() {
        return Err("`path` is empty.".into());
    }
    let path = resolve(raw, Path::new(&chat.work_dir()));
    let engine = mcp::engine(&app)?;
    let shown = raw.to_owned();
    blocking(move || {
        let meta = std::fs::metadata(&path).map_err(|_| format!("There's no file at {shown}."))?;
        if !meta.is_file() {
            return Err(format!("{shown} isn't a file."));
        }
        if meta.len() > MAX_IMAGE {
            return Err(format!(
                "{shown} is {} MB; {} MB at most.",
                meta.len() / 1024 / 1024,
                MAX_IMAGE / 1024 / 1024
            ));
        }
        let bytes = std::fs::read(&path).map_err(|e| format!("Couldn't read {shown}: {e}"))?;
        let mime = image_type(&bytes).ok_or_else(|| {
            format!("{shown} isn't an image Hive can show (PNG, JPEG, GIF, WebP, AVIF, BMP, ICO, SVG).")
        })?;
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "image".into());
        let saved = engine
            .store()
            .attachments()
            .save(&name, &bytes)
            .map_err(|e| format!("Couldn't save the image: {e}"))?;
        Ok(result(saved.path, mime, &name, caption, background))
    })
    .await
}

/// `show_svg`: saves the markup as an `.svg` file.
pub async fn show_svg(app: AppHandle, ctx: Ctx, args: Value) -> Result<Value, String> {
    mcp::chat_id(&ctx)?;
    let args: SvgArgs = mcp::args(args)?;
    let (caption, background) = shared(args.shared)?;
    let svg = prepare_svg(&args.svg)?;
    let title = args.title.as_deref().map(str::trim).filter(|t| !t.is_empty());
    let name = format!("{}.svg", file_stem(title.unwrap_or("image")));
    let engine = mcp::engine(&app)?;
    blocking(move || {
        let saved = engine
            .store()
            .attachments()
            .save(&name, svg.as_bytes())
            .map_err(|e| format!("Couldn't save the SVG: {e}"))?;
        Ok(result(saved.path, "image/svg+xml", &name, caption, background))
    })
    .await
}

fn result(
    file: String,
    mime: &str,
    name: &str,
    caption: Option<String>,
    background: &str,
) -> Value {
    json!({
        "image": {
            "file": file,
            "mimeType": mime,
            "name": name,
            "caption": caption,
            "background": background,
        },
        "message": SHOWN,
    })
}

/// The caption (trimmed, None when empty) and the background, checked.
fn shared(args: Shared) -> Result<(Option<String>, &'static str), String> {
    let caption = args
        .caption
        .map(|c| c.trim().to_owned())
        .filter(|c| !c.is_empty());
    if caption.as_ref().is_some_and(|c| c.chars().count() > MAX_CAPTION) {
        return Err(format!("`caption` is over {MAX_CAPTION} characters."));
    }
    let background = match args.background.as_deref().map(str::trim) {
        None | Some("") | Some("none") => "none",
        Some("light") => "light",
        Some(other) => return Err(format!("`background` is \"none\" or \"light\", not \"{other}\".")),
    };
    Ok((caption, background))
}

/// `raw` as a path: absolute as is, else under `base`.
fn resolve(raw: &str, base: &Path) -> PathBuf {
    let raw = raw.strip_prefix("file://").unwrap_or(raw);
    // `file:///C:/x.png` → `C:/x.png`.
    let raw = match raw.as_bytes() {
        [b'/', _, b':', ..] => &raw[1..],
        _ => raw,
    };
    let path = Path::new(raw);
    if path.is_absolute() {
        path.to_owned()
    } else {
        base.join(path)
    }
}

/// The markup checked, with the SVG namespace an `<img>` needs to draw it.
fn prepare_svg(svg: &str) -> Result<String, String> {
    let svg = svg.trim_start_matches('\u{feff}').trim();
    if svg.is_empty() {
        return Err("`svg` is empty.".into());
    }
    if svg.len() > MAX_SVG {
        return Err(format!(
            "The SVG is {} KB; {} KB at most.",
            svg.len() / 1000,
            MAX_SVG / 1000
        ));
    }
    if image_type(svg.as_bytes()) != Some("image/svg+xml") {
        return Err("`svg` has to start with <svg (or an <?xml declaration).".into());
    }
    let lower = svg.to_ascii_lowercase();
    let Some(open) = lower.find("<svg") else {
        return Err("`svg` has no <svg> element.".into());
    };
    if !lower.contains("</svg>") && !lower[open..].split('>').next().unwrap_or("").ends_with('/') {
        return Err("`svg` isn't closed: it has no </svg>.".into());
    }
    let tag_end = lower[open..]
        .find('>')
        .map(|i| open + i)
        .ok_or("`svg`'s <svg> tag isn't closed.")?;
    if lower[open..tag_end].contains("xmlns=") {
        return Ok(svg.to_owned());
    }
    let at = open + "<svg".len();
    Ok(format!(
        "{} xmlns=\"http://www.w3.org/2000/svg\"{}",
        &svg[..at],
        &svg[at..]
    ))
}

/// A file name for the image: its title, kept to safe characters.
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
        "image".into()
    } else {
        stem
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn svgs_get_the_namespace_once() {
        let out = prepare_svg("<svg width=\"10\"><rect/></svg>").unwrap();
        assert!(out.starts_with("<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"10\">"));
        let ns = "<svg xmlns=\"http://www.w3.org/2000/svg\"><rect/></svg>";
        assert_eq!(prepare_svg(ns).unwrap(), ns);
        let xml = prepare_svg("<?xml version=\"1.0\"?>\n<svg><g/></svg>").unwrap();
        assert!(xml.contains("<svg xmlns="));
    }

    #[test]
    fn non_svgs_are_refused() {
        assert!(prepare_svg("").is_err());
        assert!(prepare_svg("<div>hi</div>").is_err());
        assert!(prepare_svg("<svg><rect/>").is_err());
    }

    #[test]
    fn relative_paths_resolve_under_the_folder() {
        let base = std::env::temp_dir();
        assert_eq!(resolve("out/plot.png", &base), base.join("out/plot.png"));
        let abs = base.join("x.png");
        assert_eq!(resolve(&abs.display().to_string(), Path::new("/elsewhere")), abs);
    }

    #[test]
    fn backgrounds_are_checked() {
        let shared = |b: Option<&str>| Shared { caption: Some("  ".into()), background: b.map(Into::into) };
        assert_eq!(super::shared(shared(None)).unwrap(), (None, "none"));
        assert_eq!(super::shared(shared(Some("light"))).unwrap().1, "light");
        assert!(super::shared(shared(Some("pink"))).is_err());
    }
}
