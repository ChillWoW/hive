//! A chat folder's files for the tabs panel's editor: text comes back with
//! `\n` line endings and is written back with the file's own (and its byte
//! order mark); a save names the hash of what it was read from and is refused
//! when the file changed since; the write goes to a temp file that replaces
//! the original. Links are never followed.

use std::hash::{DefaultHasher, Hasher};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use outcode_proto::{FileText, LineEnding, ReadOnlyReason, WriteOutcome};
use tauri::ipc::Response;

/// Past this a file is shown but not editable.
const MAX_EDITABLE: u64 = 1024 * 1024;
/// Past this a file's text isn't read at all.
const MAX_PREVIEW: u64 = 8 * 1024 * 1024;
const BOM: &[u8] = b"\xEF\xBB\xBF";

fn err(error: impl std::fmt::Display) -> String {
    error.to_string()
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work).await.map_err(err)?
}

/// Enough to tell versions of a file apart within a run (not a checksum).
fn hash(bytes: &[u8]) -> String {
    let mut hasher = DefaultHasher::new();
    hasher.write(bytes);
    format!("{:016x}:{}", hasher.finish(), bytes.len())
}

/// `path` (relative, `/`-separated, not "") under `cwd`, refused when it would leave it.
pub(crate) fn resolve(cwd: &str, path: &str) -> Result<PathBuf, String> {
    let relative = Path::new(path);
    if path.is_empty() || !relative.components().all(|c| matches!(c, Component::Normal(_))) {
        return Err(format!("{path} is not inside the folder"));
    }
    Ok(Path::new(cwd).join(relative))
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
    let meta = std::fs::symlink_metadata(file).map_err(err)?;
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

    let bytes = std::fs::read(file).map_err(err)?;
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
    let line_ending = if crlf > 0 && lone_lf == 0 { LineEnding::Crlf } else { LineEnding::Lf };
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
        Err(error) => Err(err(error)),
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
        Err(error) => return Err(err(error)),
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
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let temp = dir.join(format!(".outcode-save-{}-{stamp}.tmp", std::process::id()));
    let result = (|| {
        let mut out = std::fs::File::create(&temp).map_err(err)?;
        out.write_all(&bytes).map_err(err)?;
        out.sync_all().map_err(err)?;
        drop(out);
        std::fs::set_permissions(&temp, meta.permissions()).map_err(err)?;
        // Once more just before replacing it: it may have changed meanwhile.
        if let Some(conflict) = changed(current_hash(file)?) {
            return Ok(conflict);
        }
        std::fs::rename(&temp, file).map_err(err)?;
        Ok(WriteOutcome::Written { hash: hash(&bytes) })
    })();
    if !matches!(result, Ok(WriteOutcome::Written { .. })) {
        let _ = std::fs::remove_file(&temp);
    }
    result
}

/// `path` (relative to `cwd`) for the editor.
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
        let meta = std::fs::symlink_metadata(&file).map_err(err)?;
        if !meta.is_file() {
            return Err(format!("{} is not a regular file", file.display()));
        }
        if meta.len() > MAX_PREVIEW {
            return Err("The file is too large to preview.".into());
        }
        std::fs::read(&file).map_err(err)
    })
    .await?;
    Ok(Response::new(bytes))
}

/// Saves `text` over `path`, unless it no longer has `expected_hash`.
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_and_writes_back_the_same_way() {
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("a.txt");
        std::fs::write(&file, b"\xEF\xBB\xBFone\r\ntwo\r\n").unwrap();

        let read1 = read(&file).unwrap();
        assert_eq!(read1.text.as_deref(), Some("one\ntwo\n"));
        assert_eq!(read1.line_ending, LineEnding::Crlf);
        assert!(read1.bom);
        assert_eq!(read1.read_only, None);

        let outcome = write(&file, "one\nthree\n", &read1.hash, LineEnding::Crlf, true).unwrap();
        assert!(matches!(outcome, WriteOutcome::Written { .. }));
        assert_eq!(std::fs::read(&file).unwrap(), b"\xEF\xBB\xBFone\r\nthree\r\n");

        // The old hash no longer matches: refused.
        let outcome = write(&file, "x", &read1.hash, LineEnding::Lf, false).unwrap();
        assert_eq!(outcome, WriteOutcome::Conflict { deleted: false });
        // No temp file left behind.
        assert_eq!(std::fs::read_dir(temp.path()).unwrap().count(), 1);
    }

    #[test]
    fn flags_what_it_cant_edit() {
        let temp = tempfile::tempdir().unwrap();
        let binary = temp.path().join("b.bin");
        std::fs::write(&binary, b"a\0b").unwrap();
        assert_eq!(read(&binary).unwrap().read_only, Some(ReadOnlyReason::Binary));
        let mixed = temp.path().join("m.txt");
        std::fs::write(&mixed, b"a\r\nb\n").unwrap();
        assert_eq!(read(&mixed).unwrap().read_only, Some(ReadOnlyReason::MixedLineEndings));
        assert!(resolve("/x", "../etc/passwd").is_err());
        assert!(resolve("/x", "").is_err());
    }
}
