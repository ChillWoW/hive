//! Starting the agents' CLIs: finding them, spawning them without a console
//! window, writing their stdin and keeping the end of their stderr.

use std::path::{Path, PathBuf};
use std::process::ExitStatus;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, ChildStderr, ChildStdin, Command};
use tokio::sync::mpsc;

/// Windows' `CREATE_NO_WINDOW`: a console child opens no window of its own.
pub(crate) const CREATE_NO_WINDOW: u32 = 0x0800_0000;
/// How much of a CLI's stderr is kept for crash messages.
const STDERR_TAIL_BYTES: usize = 4096;
/// How long a CLI gets to exit after stdin closes before it's killed.
pub(crate) const EXIT_GRACE: Duration = Duration::from_secs(3);
/// How long an interrupted turn may take to report its end before the run
/// reports it interrupted anyway.
pub(crate) const INTERRUPT_SETTLE: Duration = Duration::from_secs(5);

pub(crate) fn home_dir() -> Option<PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from)
}

/// `name` on PATH, else the first of `locations` that exists: where its
/// installers put it. An app started from Finder or the Start menu may not
/// see the shell's PATH, and one running when the CLI was installed never
/// sees the new entry.
pub(crate) fn find(name: &str, locations: Vec<PathBuf>) -> Option<PathBuf> {
    find_on_path(name).or_else(|| locations.into_iter().find(|p| p.is_file()))
}

pub(crate) fn find_on_path(name: &str) -> Option<PathBuf> {
    let candidates: &[&str] = if cfg!(windows) {
        &["exe", "cmd", "bat"]
    } else {
        &[""]
    };
    std::env::split_paths(&std::env::var_os("PATH")?).find_map(|dir| {
        candidates.iter().find_map(|ext| {
            let path = dir.join(name).with_extension(ext);
            path.is_file().then_some(path)
        })
    })
}

/// A command running `exe` without a console window. npm installs `.cmd`
/// shims, which only run through `cmd /C`.
pub(crate) fn command(exe: &Path) -> Command {
    let is_batch = exe
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("cmd") || e.eq_ignore_ascii_case("bat"));
    let mut cmd = if is_batch {
        let mut cmd = Command::new("cmd");
        cmd.arg("/C").arg(exe);
        cmd
    } else {
        Command::new(exe)
    };
    no_window(&mut cmd);
    cmd
}

pub(crate) fn no_window(cmd: &mut Command) {
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    #[cfg(not(windows))]
    let _ = cmd;
}

/// Writes lines in order; dropping every sender closes stdin.
pub(crate) async fn write_stdin(mut stdin: ChildStdin, mut lines: mpsc::UnboundedReceiver<String>) {
    while let Some(mut line) = lines.recv().await {
        line.push('\n');
        if stdin.write_all(line.as_bytes()).await.is_err() || stdin.flush().await.is_err() {
            return;
        }
    }
}

/// The last few KB a CLI printed to stderr, for crash messages.
#[derive(Clone, Default)]
pub(crate) struct StderrTail(Arc<Mutex<String>>);

impl StderrTail {
    /// Follows `stderr` until it closes.
    pub(crate) fn collect(mut stderr: ChildStderr) -> Self {
        let tail = Self::default();
        let kept = Arc::clone(&tail.0);
        tokio::spawn(async move {
            let mut buf = [0u8; 1024];
            while let Ok(n) = stderr.read(&mut buf).await {
                if n == 0 {
                    return;
                }
                let mut tail = kept.lock().unwrap();
                tail.push_str(&String::from_utf8_lossy(&buf[..n]));
                if tail.len() > STDERR_TAIL_BYTES {
                    let mut cut = tail.len() - STDERR_TAIL_BYTES;
                    while !tail.is_char_boundary(cut) {
                        cut += 1;
                    }
                    tail.drain(..cut);
                }
            }
        });
        tail
    }

    pub(crate) fn text(&self) -> String {
        self.0.lock().unwrap().trim().to_owned()
    }

    /// `message`, with what was printed on the lines under it.
    pub(crate) fn under(&self, message: impl Into<String>) -> String {
        let mut message = message.into();
        let stderr = self.text();
        if !stderr.is_empty() {
            message.push('\n');
            message.push_str(&stderr);
        }
        message
    }
}

/// A process's exit code for a message; `unknown` without one.
pub(crate) fn exit_code(status: Option<ExitStatus>) -> String {
    status
        .and_then(|s| s.code())
        .map_or("unknown".to_owned(), |c| c.to_string())
}

/// Waits [`EXIT_GRACE`] for `child` to exit, then kills it.
pub(crate) async fn wait_or_kill(child: &mut Child) -> Option<ExitStatus> {
    match tokio::time::timeout(EXIT_GRACE, child.wait()).await {
        Ok(status) => status.ok(),
        Err(_) => {
            let _ = child.kill().await;
            None
        }
    }
}

/// Never wakes without a deadline.
pub(crate) async fn sleep_until(deadline: Option<tokio::time::Instant>) {
    match deadline {
        Some(at) => tokio::time::sleep_until(at).await,
        None => std::future::pending().await,
    }
}
