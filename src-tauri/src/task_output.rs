//! A background shell's output, live: the agent CLI writes it to a file
//! (`BackgroundTask::output_file`), which is followed here and streamed to
//! the page as raw bytes over a channel. A webview's watches end when its
//! page reloads, since their channels die with it.

use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{State, Webview};

/// How often the file is checked for more.
const POLL: Duration = Duration::from_millis(120);

/// The most of what's already in the file that is sent: its tail.
const BACKLOG: u64 = 2 * 1024 * 1024;

struct Watch {
    /// The webview that opened it.
    owner: String,
    stop: Arc<AtomicBool>,
}

/// The output files being followed, by watch id.
#[derive(Default)]
pub struct TaskOutputs {
    next: AtomicU32,
    live: Mutex<HashMap<u32, Watch>>,
}

impl TaskOutputs {
    /// Ends the watches `owner` opened.
    pub fn stop_owned_by(&self, owner: &str) {
        self.live.lock().unwrap().retain(|_, watch| {
            let theirs = watch.owner == owner;
            if theirs {
                watch.stop.store(true, Ordering::Relaxed);
            }
            !theirs
        });
    }
}

/// Only what the CLI names for a task: `…/tasks/<id>.output`.
fn is_task_output(path: &Path) -> bool {
    path.is_absolute()
        && path.extension().is_some_and(|ext| ext == "output")
        && path
            .parent()
            .and_then(Path::file_name)
            .is_some_and(|dir| dir == "tasks")
}

/// Sends `path` as it grows until `stop` is set or the page is gone. Starts
/// with what's there (the last [`BACKLOG`] of it, from a line's start); a
/// file that isn't there yet is waited for.
fn follow(path: &Path, stop: &AtomicBool, on_data: &Channel<InvokeResponseBody>) {
    let mut at: Option<u64> = None;
    while !stop.load(Ordering::Relaxed) {
        if let Ok(mut file) = File::open(path)
            && let Ok(len) = file.metadata().map(|m| m.len())
        {
            let cut = at.is_none() && len > BACKLOG;
            // Shorter than what was read: written over, so from its start.
            let from = match at {
                Some(at) if at <= len => at,
                Some(_) => 0,
                None => len.saturating_sub(BACKLOG),
            };
            let mut bytes = Vec::new();
            if len > from
                && file.seek(SeekFrom::Start(from)).is_ok()
                && file.take(len - from).read_to_end(&mut bytes).is_ok()
            {
                at = Some(from + bytes.len() as u64);
                if cut && let Some(line) = bytes.iter().position(|b| *b == b'\n') {
                    bytes.drain(..=line);
                }
                if !bytes.is_empty() && on_data.send(InvokeResponseBody::Raw(bytes)).is_err() {
                    return;
                }
            } else {
                at = Some(from);
            }
        }
        std::thread::sleep(POLL);
    }
}

/// Follows a background task's output file: `on_data` gets what's in it, then
/// more as it's written. Returns the watch's id, for `task_output_unwatch`.
#[tauri::command]
pub fn task_output_watch(
    webview: Webview,
    outputs: State<'_, TaskOutputs>,
    path: String,
    on_data: Channel<InvokeResponseBody>,
) -> Result<u32, String> {
    let path = PathBuf::from(path);
    if !is_task_output(&path) {
        return Err("not a task's output file".into());
    }
    let id = outputs.next.fetch_add(1, Ordering::Relaxed);
    let stop = Arc::new(AtomicBool::new(false));
    outputs.live.lock().unwrap().insert(
        id,
        Watch {
            owner: webview.label().to_owned(),
            stop: stop.clone(),
        },
    );
    std::thread::Builder::new()
        .name("task-output".into())
        .spawn(move || follow(&path, &stop, &on_data))
        .map_err(|e| e.to_string())?;
    Ok(id)
}

#[tauri::command]
pub fn task_output_unwatch(outputs: State<'_, TaskOutputs>, id: u32) {
    if let Some(watch) = outputs.live.lock().unwrap().remove(&id) {
        watch.stop.store(true, Ordering::Relaxed);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_task_output_files_are_followed() {
        let root = if cfg!(windows) { "C:\\tmp" } else { "/tmp" };
        let dir = Path::new(root).join("claude").join("tasks");
        assert!(is_task_output(&dir.join("b1.output")));
        assert!(!is_task_output(&dir.join("b1.txt")));
        assert!(!is_task_output(&Path::new(root).join("b1.output")));
        assert!(!is_task_output(Path::new("tasks/b1.output")));
    }
}
