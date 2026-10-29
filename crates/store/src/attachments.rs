//! Files sent with prompts: Hive's own copies, under `attachments/` in the
//! data dir, each in a folder of its own (`attachments/{id}/{name}`) so it
//! keeps its name for the agent.

use std::path::{Component, Path, PathBuf};

use hive_proto::Attachment;

use crate::{new_id, Result, StoreError};

/// Largest file Hive takes as an attachment.
pub const MAX_ATTACHMENT_BYTES: usize = 32 * 1024 * 1024;

pub struct Attachments {
    dir: PathBuf,
}

impl Attachments {
    pub(crate) fn open(dir: PathBuf) -> Result<Self> {
        std::fs::create_dir_all(&dir)?;
        Ok(Self { dir })
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// Copies `bytes` in as a file called `name`.
    pub fn save(&self, name: &str, bytes: &[u8]) -> Result<Attachment> {
        if bytes.len() > MAX_ATTACHMENT_BYTES {
            return Err(StoreError::Attachment(format!(
                "{name} is over the {} MB limit.",
                MAX_ATTACHMENT_BYTES / 1024 / 1024
            )));
        }
        let name = display_name(name);
        let folder = self.dir.join(new_id());
        std::fs::create_dir_all(&folder)?;
        let path = folder.join(file_name(&name));
        std::fs::write(&path, bytes)?;
        Ok(Attachment {
            path: path.display().to_string(),
            mime_type: mime_type(&name, bytes).to_owned(),
            size: bytes.len() as u64,
            name,
        })
    }

    /// `path` as a file of Hive's attachments; `None` for anything else,
    /// including paths that only lead into the folder (`..`, links).
    pub fn resolve(&self, path: &str) -> Option<PathBuf> {
        let file = Path::new(path).canonicalize().ok()?;
        let dir = self.dir.canonicalize().ok()?;
        (file.starts_with(&dir) && file.is_file()).then_some(file)
    }

    /// The folder holding the attachment at `path`, if it's one of ours.
    fn folder_of(&self, path: &str) -> Option<PathBuf> {
        let relative = Path::new(path).strip_prefix(&self.dir).ok()?;
        match relative.components().next()? {
            Component::Normal(id) => Some(self.dir.join(id)),
            _ => None,
        }
    }

    /// Deletes the attachments' files, best-effort: what's left is swept at
    /// the next launch.
    pub(crate) fn remove<'a>(&self, paths: impl IntoIterator<Item = &'a str>) {
        for path in paths {
            if let Some(folder) = self.folder_of(path) {
                let _ = std::fs::remove_dir_all(folder);
            }
        }
    }

    /// The attachment folders, by id.
    pub(crate) fn folders(&self) -> Result<Vec<(String, PathBuf)>> {
        let mut out = Vec::new();
        for entry in std::fs::read_dir(&self.dir)? {
            let entry = entry?;
            if entry.file_type()?.is_dir() {
                out.push((entry.file_name().to_string_lossy().into_owned(), entry.path()));
            }
        }
        Ok(out)
    }
}

/// The name as shown: its last path segment, trimmed.
fn display_name(name: &str) -> String {
    let name = name.rsplit(['/', '\\']).next().unwrap_or_default().trim();
    if name.is_empty() {
        "file".into()
    } else {
        name.into()
    }
}

/// A name every file system takes: no separators, reserved or control
/// characters, no trailing dots or spaces, no device names, 120 chars at most.
fn file_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect();
    let mut cleaned: String = if cleaned.chars().count() > 120 {
        // Keep the extension.
        let ext = Path::new(&cleaned)
            .extension()
            .map(|e| format!(".{}", e.to_string_lossy()))
            .filter(|e| e.len() <= 16)
            .unwrap_or_default();
        let stem: String = cleaned.chars().take(120 - ext.chars().count()).collect();
        format!("{stem}{ext}")
    } else {
        cleaned
    };
    while cleaned.ends_with(['.', ' ']) {
        cleaned.pop();
    }
    let stem = cleaned.split('.').next().unwrap_or_default().to_ascii_uppercase();
    let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.as_bytes()[3].is_ascii_digit());
    if reserved {
        cleaned.insert(0, '_');
    }
    if cleaned.is_empty() {
        "file".into()
    } else {
        cleaned
    }
}

/// Images by content, everything else by extension.
fn mime_type(name: &str, bytes: &[u8]) -> &'static str {
    match bytes {
        [0x89, b'P', b'N', b'G', ..] => return "image/png",
        [0xFF, 0xD8, 0xFF, ..] => return "image/jpeg",
        [b'G', b'I', b'F', b'8', ..] => return "image/gif",
        [b'R', b'I', b'F', b'F', _, _, _, _, b'W', b'E', b'B', b'P', ..] => return "image/webp",
        _ => {}
    }
    let ext = Path::new(name)
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "pdf" => "application/pdf",
        "json" => "application/json",
        "zip" => "application/zip",
        "csv" => "text/csv",
        "html" | "htm" => "text/html",
        "css" => "text/css",
        "md" | "markdown" => "text/markdown",
        "txt" | "log" | "rs" | "ts" | "tsx" | "js" | "jsx" | "py" | "go" | "java" | "c" | "h"
        | "cpp" | "hpp" | "cs" | "rb" | "php" | "sh" | "ps1" | "toml" | "yaml" | "yml"
        | "xml" | "sql" | "swift" | "kt" | "lua" | "ini" | "env" => "text/plain",
        _ if std::str::from_utf8(&bytes[..bytes.len().min(4096)]).is_ok() && !bytes.is_empty() => {
            "text/plain"
        }
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saves_a_copy_under_its_own_name() {
        let dir = tempfile::tempdir().unwrap();
        let attachments = Attachments::open(dir.path().join("attachments")).unwrap();
        let a = attachments.save("C:\\shots\\screen.png", b"\x89PNG\r\n").unwrap();
        assert_eq!(a.name, "screen.png");
        assert_eq!(a.mime_type, "image/png");
        assert_eq!(a.size, 6);
        assert!(a.path.ends_with("screen.png"));
        assert_eq!(std::fs::read(&a.path).unwrap(), b"\x89PNG\r\n");
        assert!(attachments.resolve(&a.path).is_some());

        attachments.remove([a.path.as_str()]);
        assert!(!Path::new(&a.path).exists());
        assert!(attachments.folders().unwrap().is_empty());
    }

    #[test]
    fn resolves_only_its_own_files() {
        let dir = tempfile::tempdir().unwrap();
        let attachments = Attachments::open(dir.path().join("attachments")).unwrap();
        let outside = dir.path().join("secret.txt");
        std::fs::write(&outside, "x").unwrap();
        assert!(attachments.resolve(&outside.display().to_string()).is_none());
        let sneaky = attachments.dir().join("..").join("secret.txt");
        assert!(attachments.resolve(&sneaky.display().to_string()).is_none());
        // Removing never leaves the folder.
        attachments.remove([outside.to_str().unwrap(), sneaky.to_str().unwrap()]);
        assert!(outside.exists());
    }

    #[test]
    fn file_names_are_safe() {
        assert_eq!(file_name("a:b?.txt"), "a_b_.txt");
        assert_eq!(file_name("con.txt"), "_con.txt");
        assert_eq!(file_name("notes. "), "notes");
        assert_eq!(file_name("..."), "file");
        let long = format!("{}.png", "x".repeat(300));
        assert_eq!(file_name(&long).len(), 120);
        assert!(file_name(&long).ends_with(".png"));
    }

    #[test]
    fn types() {
        assert_eq!(mime_type("x.bin", b"\xFF\xD8\xFF\xE0"), "image/jpeg");
        assert_eq!(mime_type("doc.PDF", b"%PDF"), "application/pdf");
        assert_eq!(mime_type("Makefile", b"all:\n"), "text/plain");
        assert_eq!(mime_type("blob", &[0, 159, 146, 150]), "application/octet-stream");
    }
}
