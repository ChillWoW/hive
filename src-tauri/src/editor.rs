//! A chat folder's files for the right sidebar's editor, as zeron reads and
//! saves them: text comes back with `\n` line endings and is written back with
//! the file's own (and its byte order mark); a save names the hash of what it
//! was read from and is refused when the file changed since; the write goes to
//! a temp file that replaces the original. Links are never followed.

use std::io::Write;
use std::path::{Component, Path, PathBuf};

use hive_proto::{FileText, LineEnding, ReadOnlyReason, WriteOutcome};
use sha2::{Digest, Sha256};
use tauri::ipc::Response;
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

/// Past this a file is shown but not editable (zeron's limits).
const MAX_EDITABLE: u64 = 1024 * 1024;
/// Past this a file's text isn't read at all.
const MAX_PREVIEW: u64 = 8 * 1024 * 1024;
const BOM: &[u8] = b"\xEF\xBB\xBF";

/// `path` (relative, `/`-separated) under `cwd`, refused when it would leave it.
fn resolve(cwd: &str, path: &str) -> Result<PathBuf, String> {
    let relative = Path::new(path);
    if path.is_empty() || !relative.components().all(|part| matches!(part, Component::Normal(_))) {
        return Err(format!("{path} is not inside the folder"));
    }
    Ok(Path::new(cwd).join(relative))
}

fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn read_only(size: u64, reason: ReadOnlyReason) -> FileText {
    FileText {
        text: None,
        hash: String::new(),
        size,
        line_ending: LineEnding::Lf,
        bom: false,
        read_only: Some(reason),
    }
}

fn read(file: &Path) -> Result<FileText, String> {
    let meta = std::fs::symlink_metadata(file).map_err(|e| e.to_string())?;
    if meta.file_type().is_symlink() {
        return Ok(read_only(meta.len(), ReadOnlyReason::Symlink));
    }
    if !meta.is_file() {
        return Err(format!("{} is not a file", file.display()));
    }
    let size = meta.len();
    if size > MAX_PREVIEW {
        return Ok(read_only(size, ReadOnlyReason::TooLarge));
    }

    let bytes = std::fs::read(file).map_err(|e| e.to_string())?;
    let hash = hash(&bytes);
    let bom = bytes.starts_with(BOM);
    let body = if bom { &bytes[BOM.len()..] } else { &bytes[..] };
    let unreadable = |reason| FileText {
        hash: hash.clone(),
        ..read_only(size, reason)
    };
    if body.contains(&0) {
        return Ok(unreadable(ReadOnlyReason::Binary));
    }
    let Ok(text) = std::str::from_utf8(body) else {
        return Ok(unreadable(ReadOnlyReason::UnsupportedEncoding));
    };

    let crlf = text.matches("\r\n").count();
    let lone_lf = text.matches('\n').count() - crlf;
    let line_ending = if crlf > 0 && lone_lf == 0 {
        LineEnding::Crlf
    } else {
        LineEnding::Lf
    };
    let read_only = if crlf > 0 && lone_lf > 0 {
        Some(ReadOnlyReason::MixedLineEndings)
    } else if size > MAX_EDITABLE {
        Some(ReadOnlyReason::TooLarge)
    } else {
        None
    };
    Ok(FileText {
        text: Some(if crlf > 0 { text.replace("\r\n", "\n") } else { text.to_owned() }),
        hash,
        size,
        line_ending,
        bom,
        read_only,
    })
}

/// The file's hash now, or `None` when it's gone.
fn current_hash(file: &Path) -> Result<Option<String>, String> {
    match std::fs::read(file) {
        Ok(bytes) => Ok(Some(hash(&bytes))),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

fn write(
    file: &Path,
    text: &str,
    expected: &str,
    line_ending: LineEnding,
    bom: bool,
) -> Result<WriteOutcome, String> {
    if text.contains(['\r', '\0']) {
        return Err("The text holds a carriage return or NUL.".into());
    }
    let meta = match std::fs::symlink_metadata(file) {
        Ok(meta) => meta,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(WriteOutcome::Conflict { deleted: true })
        }
        Err(error) => return Err(error.to_string()),
    };
    if !meta.is_file() {
        return Err(format!("{} is not a regular file", file.display()));
    }
    let changed = |now: Option<String>| match now {
        None => Some(WriteOutcome::Conflict { deleted: true }),
        Some(now) if now != expected => Some(WriteOutcome::Conflict { deleted: false }),
        Some(_) => None,
    };
    if let Some(conflict) = changed(current_hash(file)?) {
        return Ok(conflict);
    }

    let mut bytes = Vec::with_capacity(text.len() + BOM.len());
    if bom {
        bytes.extend_from_slice(BOM);
    }
    match line_ending {
        LineEnding::Lf => bytes.extend_from_slice(text.as_bytes()),
        LineEnding::Crlf => bytes.extend_from_slice(text.replace('\n', "\r\n").as_bytes()),
    }
    if bytes.len() as u64 > MAX_EDITABLE {
        return Err("The file is too large to save here.".into());
    }

    let dir = file.parent().ok_or("The file has no folder.")?;
    let temp = dir.join(format!(".hive-save-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut out = std::fs::File::create(&temp).map_err(|e| e.to_string())?;
        out.write_all(&bytes).map_err(|e| e.to_string())?;
        out.sync_all().map_err(|e| e.to_string())?;
        drop(out);
        std::fs::set_permissions(&temp, meta.permissions()).map_err(|e| e.to_string())?;
        // Once more just before replacing it: it may have changed meanwhile.
        if let Some(conflict) = changed(current_hash(file)?) {
            return Ok(conflict);
        }
        std::fs::rename(&temp, file).map_err(|e| e.to_string())?;
        Ok(WriteOutcome::Written { hash: hash(&bytes) })
    })();
    if !matches!(result, Ok(WriteOutcome::Written { .. })) {
        let _ = std::fs::remove_file(&temp);
    }
    result
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn read_file(cwd: String, path: String) -> Result<FileText, String> {
    let file = resolve(&cwd, &path)?;
    blocking(move || read(&file)).await
}

/// A file's raw bytes (an image preview), up to the preview size.
#[tauri::command]
pub async fn read_file_bytes(cwd: String, path: String) -> Result<Response, String> {
    let file = resolve(&cwd, &path)?;
    let bytes = blocking(move || {
        let meta = std::fs::symlink_metadata(&file).map_err(|e| e.to_string())?;
        if !meta.is_file() {
            return Err(format!("{} is not a regular file", file.display()));
        }
        if meta.len() > MAX_PREVIEW {
            return Err("The file is too large to preview.".into());
        }
        std::fs::read(&file).map_err(|e| e.to_string())
    })
    .await?;
    Ok(Response::new(bytes))
}

#[tauri::command]
pub async fn write_file(
    cwd: String,
    path: String,
    text: String,
    expected_hash: String,
    line_ending: LineEnding,
    bom: bool,
) -> Result<WriteOutcome, String> {
    let file = resolve(&cwd, &path)?;
    blocking(move || write(&file, &text, &expected_hash, line_ending, bom)).await
}

/// Opens a file in its default app.
#[tauri::command]
pub async fn open_file(app: AppHandle, cwd: String, path: String) -> Result<(), String> {
    let file = resolve(&cwd, &path)?;
    app.opener()
        .open_path(file.display().to_string(), None::<&str>)
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("hive-editor-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn reads_text_with_its_line_endings_and_bom() {
        let dir = temp_dir("read");
        std::fs::write(dir.join("crlf.txt"), b"\xEF\xBB\xBFa\r\nb\r\n").unwrap();
        let file = read(&dir.join("crlf.txt")).unwrap();
        assert_eq!(file.text.as_deref(), Some("a\nb\n"));
        assert_eq!(file.line_ending, LineEnding::Crlf);
        assert!(file.bom);
        assert_eq!(file.read_only, None);

        std::fs::write(dir.join("mixed.txt"), "a\r\nb\n").unwrap();
        assert_eq!(
            read(&dir.join("mixed.txt")).unwrap().read_only,
            Some(ReadOnlyReason::MixedLineEndings)
        );
        std::fs::write(dir.join("bin"), b"a\0b").unwrap();
        let bin = read(&dir.join("bin")).unwrap();
        assert_eq!((bin.text, bin.read_only), (None, Some(ReadOnlyReason::Binary)));
        std::fs::write(dir.join("latin1.txt"), b"caf\xE9").unwrap();
        assert_eq!(
            read(&dir.join("latin1.txt")).unwrap().read_only,
            Some(ReadOnlyReason::UnsupportedEncoding)
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn saves_back_the_same_way_and_refuses_a_changed_file() {
        let dir = temp_dir("write");
        let path = dir.join("a.txt");
        std::fs::write(&path, b"\xEF\xBB\xBFone\r\n").unwrap();
        let file = read(&path).unwrap();

        let WriteOutcome::Written { hash } =
            write(&path, "one\ntwo\n", &file.hash, file.line_ending, file.bom).unwrap()
        else {
            panic!("not written");
        };
        assert_eq!(std::fs::read(&path).unwrap(), b"\xEF\xBB\xBFone\r\ntwo\r\n");
        assert_eq!(hash, read(&path).unwrap().hash);

        // Saving again from the first read: the file has moved on.
        assert_eq!(
            write(&path, "x\n", &file.hash, LineEnding::Lf, false).unwrap(),
            WriteOutcome::Conflict { deleted: false }
        );
        std::fs::remove_file(&path).unwrap();
        assert_eq!(
            write(&path, "x\n", &hash, LineEnding::Lf, false).unwrap(),
            WriteOutcome::Conflict { deleted: true }
        );
        // No temp files left behind.
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn stays_inside_the_folder() {
        assert!(resolve("/x", "../etc/passwd").is_err());
        assert!(resolve("/x", "a/../../b").is_err());
        assert!(resolve("/x", "").is_err());
        assert!(resolve("/x", "src/main.rs").is_ok());
    }
}
