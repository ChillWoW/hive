//! outcode-terminal — the user's shell in a pseudo-terminal, for the tabs
//! panel's terminal tabs.
//!
//! [`Terminals::spawn`] starts a [`Shell`] in a pty; its output goes to a
//! [`Sink`] as raw bytes, coalesced while it comes faster than it's taken
//! (and the shell is held up once a backlog builds, rather than buffering
//! without bound). Input and resizes go back by id. What runs in front of
//! each shell is looked up once a second and sent when it changes, for the
//! tab's title.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, TryRecvError};
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::time::Duration;

use portable_pty::{ChildKiller, MasterPty, PtySize, native_pty_system};
use sysinfo::System;

mod foreground;
mod shell;

pub use shell::Shell;

/// Where a terminal's output and events go. Called from the terminal's own
/// threads.
pub trait Sink: Send + Sync + 'static {
    /// Output, as the shell wrote it (UTF-8 may split across calls). False
    /// once the far end is gone: reading stops.
    fn data(&self, bytes: Vec<u8>) -> bool;
    /// What runs in front changed: a program's name (`cargo`, `vim`), or
    /// `None` while the shell itself is.
    fn process(&self, name: Option<String>) -> bool;
    /// The shell has gone and its last output was sent: its exit code, `None`
    /// when a signal ended it.
    fn exit(&self, code: Option<u32>);
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("couldn't open a terminal: {0}")]
    Pty(String),
    #[error("couldn't start {program}: {reason}")]
    Spawn { program: String, reason: String },
}

/// A started terminal.
#[derive(Debug, Clone)]
pub struct Started {
    pub id: u32,
    /// The shell's name, e.g. `zsh` or `pwsh`.
    pub shell: String,
}

/// Output chunks waiting to be sent before the shell is held up.
const BACKLOG: usize = 64;
/// The most bytes sent at once when output piles up.
const BATCH: usize = 256 * 1024;
/// After the shell exits, how long its output may take to drain (a program it
/// left in the background can hold the pty open forever).
const DRAIN: Duration = Duration::from_millis(500);
/// After a polite hangup, how long a shell has before it's killed.
const GRACE: Duration = Duration::from_secs(3);
/// How often what runs in front is looked up.
const POLL: Duration = Duration::from_secs(1);

struct Session {
    /// Whoever started it (a webview's label), for [`Terminals::kill_owned_by`].
    owner: String,
    master: Box<dyn MasterPty + Send>,
    /// Input, written in order by the session's writer thread.
    input: mpsc::Sender<Vec<u8>>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    /// The shell's process id.
    pid: Option<u32>,
    sink: Arc<dyn Sink>,
    /// The last thing sent to `sink.process`.
    process: Option<Option<String>>,
}

impl Session {
    /// The pty's foreground process group, where the OS keeps one.
    fn leader(&self) -> Option<u32> {
        #[cfg(unix)]
        {
            self.master.process_group_leader().and_then(|pid| u32::try_from(pid).ok())
        }
        #[cfg(not(unix))]
        {
            None
        }
    }
}

#[derive(Default)]
struct Inner {
    next: AtomicU32,
    sessions: Mutex<HashMap<u32, Session>>,
    /// The process table, shared by the poller and [`Terminals::foreground`].
    system: Mutex<Option<System>>,
    poller: OnceLock<()>,
}

/// Every open terminal. Cheap to clone; clones share them.
#[derive(Clone, Default)]
pub struct Terminals(Arc<Inner>);

impl Terminals {
    /// Starts `shell` in a `cols`×`rows` pty, owned by `owner`.
    pub fn spawn(
        &self,
        owner: &str,
        shell: &Shell,
        cols: u16,
        rows: u16,
        sink: impl Sink,
    ) -> Result<Started, Error> {
        let pty = |e: Box<dyn std::fmt::Display>| Error::Pty(e.to_string());
        let pair = native_pty_system()
            .openpty(size(cols, rows))
            .map_err(|e| pty(Box::new(e)))?;
        let cmd = shell.command();
        let program = shell::display_name(&cmd);
        let mut child = pair.slave.spawn_command(cmd).map_err(|e| Error::Spawn {
            program: program.clone(),
            reason: e.to_string(),
        })?;
        // The child holds its own end; ours would keep the output open past its exit.
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().map_err(|e| pty(Box::new(e)))?;
        let mut writer = pair.master.take_writer().map_err(|e| pty(Box::new(e)))?;
        let sink: Arc<dyn Sink> = Arc::new(sink);

        let (input, inbox) = mpsc::channel::<Vec<u8>>();
        std::thread::spawn(move || {
            for bytes in inbox {
                if writer.write_all(&bytes).and_then(|()| writer.flush()).is_err() {
                    break;
                }
            }
        });

        // Read → bounded queue → sender, so a burst goes out as a few big
        // messages and a slow page holds the shell up instead of piling up here.
        let (chunks, queue) = mpsc::sync_channel::<Vec<u8>>(BACKLOG);
        std::thread::spawn(move || {
            let mut buf = vec![0u8; 16 * 1024];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if chunks.send(buf[..n].to_vec()).is_err() {
                            break;
                        }
                    }
                }
            }
        });
        let (drained, on_drained) = mpsc::channel::<()>();
        let out = sink.clone();
        std::thread::spawn(move || {
            let _drained = drained;
            while let Ok(mut batch) = queue.recv() {
                while batch.len() < BATCH {
                    match queue.try_recv() {
                        Ok(more) => batch.extend_from_slice(&more),
                        Err(TryRecvError::Empty | TryRecvError::Disconnected) => break,
                    }
                }
                if !out.data(batch) {
                    break;
                }
            }
        });

        let id = self.0.next.fetch_add(1, Ordering::Relaxed) + 1;
        let session = Session {
            owner: owner.to_owned(),
            killer: child.clone_killer(),
            pid: child.process_id(),
            master: pair.master,
            input,
            sink: sink.clone(),
            process: None,
        };
        self.0.sessions.lock().unwrap().insert(id, session);
        self.start_poller();

        let inner = Arc::downgrade(&self.0);
        std::thread::spawn(move || {
            let status = child.wait().ok();
            // Dropping the master ends the output (ConPTY keeps it open until then).
            if let Some(inner) = inner.upgrade() {
                drop(inner.sessions.lock().unwrap().remove(&id));
            }
            match on_drained.recv_timeout(DRAIN) {
                Ok(()) | Err(RecvTimeoutError::Disconnected | RecvTimeoutError::Timeout) => {}
            }
            let code = status.filter(|s| s.signal().is_none()).map(|s| s.exit_code());
            sink.exit(code);
        });

        Ok(Started { id, shell: program })
    }

    /// Types `bytes` into terminal `id`, in order, without waiting for it.
    pub fn write(&self, id: u32, bytes: Vec<u8>) {
        if let Some(session) = self.0.sessions.lock().unwrap().get(&id) {
            let _ = session.input.send(bytes);
        }
    }

    pub fn resize(&self, id: u32, cols: u16, rows: u16) -> Result<(), Error> {
        match self.0.sessions.lock().unwrap().get(&id) {
            Some(session) => session.master.resize(size(cols, rows)).map_err(|e| Error::Pty(e.to_string())),
            None => Ok(()),
        }
    }

    /// Hangs up terminal `id` (its `exit` still follows).
    pub fn kill(&self, id: u32) {
        self.kill_where(|session_id, _| session_id == id);
    }

    /// Hangs up every terminal `owner` started.
    pub fn kill_owned_by(&self, owner: &str) {
        self.kill_where(|_, session| session.owner == owner);
    }

    pub fn kill_all(&self) {
        self.kill_where(|_, _| true);
    }

    /// Whether any terminal is open.
    pub fn any(&self) -> bool {
        !self.0.sessions.lock().unwrap().is_empty()
    }

    /// What runs in front of terminal `id` now, as `Sink::process` reports
    /// it. Reads the process table, so call it off the UI thread.
    pub fn foreground(&self, id: u32) -> Option<String> {
        let (pid, leader) = {
            let sessions = self.0.sessions.lock().unwrap();
            let session = sessions.get(&id)?;
            (session.pid?, session.leader())
        };
        with_system(&self.0, |system| foreground::find(system, pid, leader)).flatten()
    }

    /// A shell gets SIGHUP, as when a terminal window closes (so it can hang
    /// up its jobs), and is killed if it's still there after [`GRACE`].
    fn kill_where(&self, which: impl Fn(u32, &Session) -> bool) {
        let mut sessions = self.0.sessions.lock().unwrap();
        for (&id, session) in sessions.iter_mut().filter(|(id, s)| which(**id, s)) {
            if hang_up(session) {
                self.kill_later(id);
            } else {
                let _ = session.killer.kill();
            }
        }
    }

    /// Kills terminal `id` after [`GRACE`], if it's still there.
    fn kill_later(&self, id: u32) {
        let inner = Arc::downgrade(&self.0);
        std::thread::spawn(move || {
            std::thread::sleep(GRACE);
            let Some(inner) = inner.upgrade() else { return };
            if let Some(session) = inner.sessions.lock().unwrap().get_mut(&id) {
                let _ = session.killer.kill();
            }
        });
    }

    /// Starts the once-a-second look at what each shell runs; it ends with
    /// the last clone of `self`.
    fn start_poller(&self) {
        self.0.poller.get_or_init(|| {
            let inner = Arc::downgrade(&self.0);
            std::thread::spawn(move || poll_loop(inner));
        });
    }
}

fn poll_loop(inner: Weak<Inner>) {
    loop {
        std::thread::sleep(POLL);
        let Some(inner) = inner.upgrade() else { return };
        poll(&inner);
    }
}

/// Sends each session's foreground process when it has changed.
fn poll(inner: &Inner) {
    let shells: Vec<(u32, u32, Option<u32>)> = {
        let sessions = inner.sessions.lock().unwrap();
        sessions
            .iter()
            .filter_map(|(&id, s)| Some((id, s.pid?, s.leader())))
            .collect()
    };
    if shells.is_empty() {
        return;
    }
    let Some(found) = with_system(inner, |system| {
        shells
            .into_iter()
            .map(|(id, pid, leader)| (id, foreground::find(system, pid, leader)))
            .collect::<Vec<_>>()
    }) else {
        return;
    };
    let mut sessions = inner.sessions.lock().unwrap();
    for (id, process) in found {
        let Some(session) = sessions.get_mut(&id) else { continue };
        if session.process.as_ref() == Some(&process) {
            continue;
        }
        if session.sink.process(process.clone()) {
            session.process = Some(process);
        }
    }
}

/// Runs `f` on the shared process table, made on first use; `None` where
/// there's none to read.
fn with_system<T>(inner: &Inner, f: impl FnOnce(&mut System) -> T) -> Option<T> {
    let mut system = inner.system.lock().unwrap();
    if system.is_none() {
        *system = System::new().ok();
    }
    system.as_mut().map(f)
}

/// SIGHUP to the shell and whatever runs in front of it; false where there's
/// no such thing (Windows), or the shell's id is unknown.
#[cfg(unix)]
fn hang_up(session: &Session) -> bool {
    let Some(pid) = session.pid.and_then(|pid| i32::try_from(pid).ok()) else {
        return false;
    };
    // SAFETY: plain signals to processes this session started.
    unsafe {
        if let Some(group) = session.leader().and_then(|g| i32::try_from(g).ok()) {
            libc::kill(-group, libc::SIGHUP);
        }
        libc::kill(pid, libc::SIGHUP);
    }
    true
}

#[cfg(not(unix))]
fn hang_up(_session: &Session) -> bool {
    false
}

fn size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        rows: rows.max(1),
        cols: cols.max(1),
        pixel_width: 0,
        pixel_height: 0,
    }
}
