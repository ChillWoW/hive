//! A project folder's own artwork (favicon, app icon) for the folder picker.

use std::path::Path;

use crate::util::data_url;

/// Where projects keep an icon, best first; the first one found decides.
const ICON_PATHS: &[&str] = &[
    "public/apple-touch-icon.png",
    "apple-touch-icon.png",
    "public/favicon.svg",
    "favicon.svg",
    "public/favicon.png",
    "public/icon.png",
    "public/logo.png",
    "favicon.png",
    "app/icon.png",
    "src/app/icon.png",
    "public/favicon.ico",
    "favicon.ico",
    "app/favicon.ico",
    "static/favicon.ico",
    "src-tauri/icons/icon.png",
    "assets/icon.png",
    "src/assets/icon.png",
];

/// Bigger than any icon has a reason to be.
const MAX_ICON_BYTES: u64 = 1024 * 1024;

/// The folder's icon as a `data:` URL. Looked up from the checkout root, so a
/// folder inside a repository wears the repository's icon.
fn icon_data_url(folder: &Path) -> Option<String> {
    let canonical = folder.canonicalize().ok()?;
    let root = canonical
        .ancestors()
        .find(|dir| dir.join(".git").exists())
        .unwrap_or(&canonical);
    for relative in ICON_PATHS {
        let path = root.join(relative);
        let Ok(meta) = std::fs::metadata(&path) else {
            continue;
        };
        if !meta.is_file() {
            continue;
        }
        // The best match being unusable means no icon, not a worse one.
        if meta.len() > MAX_ICON_BYTES {
            return None;
        }
        let bytes = std::fs::read(&path).ok()?;
        let mime = match path.extension().and_then(|e| e.to_str()) {
            Some("svg") => "image/svg+xml",
            Some("ico") => "image/x-icon",
            _ => "image/png",
        };
        return Some(data_url(mime, &bytes));
    }
    None
}

/// Null when the folder has no icon (the picker draws a monogram instead).
#[tauri::command]
pub async fn folder_icon(path: String) -> Option<String> {
    tokio::task::spawn_blocking(move || icon_data_url(Path::new(&path)))
        .await
        .ok()
        .flatten()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_best_icon_from_the_checkout_root() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        assert_eq!(icon_data_url(root), None);

        std::fs::write(root.join("favicon.ico"), b"ico").unwrap();
        assert!(icon_data_url(root).unwrap().starts_with("data:image/x-icon;base64,"));

        std::fs::create_dir_all(root.join("public")).unwrap();
        std::fs::write(root.join("public/favicon.svg"), b"<svg/>").unwrap();
        assert_eq!(
            icon_data_url(root).as_deref(),
            Some("data:image/svg+xml;base64,PHN2Zy8+")
        );

        // A folder inside the checkout wears the checkout's icon.
        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::create_dir_all(root.join("src/nested")).unwrap();
        assert!(icon_data_url(&root.join("src/nested")).unwrap().starts_with("data:image/svg+xml"));
    }

    #[test]
    fn a_missing_folder_has_no_icon() {
        assert_eq!(icon_data_url(Path::new("/definitely/not/here")), None);
    }
}
