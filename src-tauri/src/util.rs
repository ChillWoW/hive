//! Small helpers the command modules share.

use std::fmt::Display;
use std::path::{Component, Path, PathBuf};

use base64::Engine as _;
use sha2::{Digest, Sha256};
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

/// An error as the webview gets it: `.map_err(err)`.
pub fn err(error: impl Display) -> String {
    error.to_string()
}

/// Runs blocking work off the async runtime.
pub async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tokio::task::spawn_blocking(work).await.map_err(err)?
}

/// `path` (relative, `/`-separated) under `root`, refused when it would leave
/// it; "" is `root` itself.
pub fn inside(root: &Path, path: &str) -> Result<PathBuf, String> {
    let relative = Path::new(path);
    if !relative.components().all(|part| matches!(part, Component::Normal(_))) {
        return Err(format!("{path} is not inside the folder"));
    }
    Ok(root.join(relative))
}

/// Opens a file in its default app.
pub fn open_path(app: &AppHandle, path: &Path) -> Result<(), String> {
    app.opener()
        .open_path(path.display().to_string(), None::<&str>)
        .map_err(err)
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub fn data_url(mime: &str, bytes: &[u8]) -> String {
    let data = base64::engine::general_purpose::STANDARD.encode(bytes);
    format!("data:{mime};base64,{data}")
}

/// An image's type by its bytes, so a renamed file that isn't one never
/// passes for one.
pub fn image_type(bytes: &[u8]) -> Option<&'static str> {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stays_inside_the_folder() {
        let root = Path::new("/x");
        assert!(inside(root, "../etc/passwd").is_err());
        assert!(inside(root, "a/../../b").is_err());
        assert!(inside(root, "/etc").is_err());
        assert_eq!(inside(root, "").unwrap(), root);
        assert_eq!(inside(root, "src/main.rs").unwrap(), root.join("src/main.rs"));
    }
}
