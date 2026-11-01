//! Files attached in the composer. The webview hands over their bytes (a
//! paste, a drop and the file input all give it `File`s, not paths) and Hive
//! keeps a copy (`hive_store::Attachments`); the transcript reads the copies
//! back for thumbnails and opens them in their default apps. Only Hive's own
//! copies can be read or opened.

use std::path::PathBuf;

use hive_engine::Engine;
use hive_proto::Attachment;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, State};

use crate::util::{err, open_path};

/// The file's name, percent-encoded (header values are ASCII).
const NAME_HEADER: &str = "x-hive-name";

/// Copies the request body in as an attachment named by `x-hive-name`.
#[tauri::command]
pub async fn save_attachment(
    engine: State<'_, Engine>,
    request: Request<'_>,
) -> Result<Attachment, String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("Expected the file's bytes.".into());
    };
    let name = request
        .headers()
        .get(NAME_HEADER)
        .and_then(|v| v.to_str().ok())
        .map(percent_decode)
        .unwrap_or_default();
    engine.store().attachments().save(&name, bytes).map_err(err)
}

/// An attachment's bytes, for its thumbnail.
#[tauri::command]
pub async fn attachment_bytes(engine: State<'_, Engine>, path: String) -> Result<Response, String> {
    let bytes = tokio::fs::read(resolve(&engine, &path)?).await.map_err(err)?;
    Ok(Response::new(bytes))
}

/// Opens an attachment in its default app.
#[tauri::command]
pub async fn open_attachment(
    app: AppHandle,
    engine: State<'_, Engine>,
    path: String,
) -> Result<(), String> {
    open_path(&app, &resolve(&engine, &path)?)
}

/// Hive's own copy at `path`, never anything else.
fn resolve(engine: &Engine, path: &str) -> Result<PathBuf, String> {
    let file = engine.store().attachments().resolve(path);
    file.ok_or_else(|| "Not an attachment.".into())
}

/// `%XX` escapes back to bytes, read as UTF-8. Malformed escapes stay as
/// they are.
fn percent_decode(raw: &str) -> String {
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let hex = |b: u8| (b as char).to_digit(16);
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(hi), Some(lo)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                out.push((hi * 16 + lo) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_names() {
        assert_eq!(percent_decode("screen%20shot.png"), "screen shot.png");
        assert_eq!(percent_decode("caf%C3%A9.txt"), "café.txt");
        assert_eq!(percent_decode("100%"), "100%");
        assert_eq!(percent_decode("a%zz"), "a%zz");
    }
}
