//! Terminals for the right sidebar: the user's shell in a pseudo-terminal
//! (`portable-pty`), its output streamed to the page as raw bytes over a
//! channel, input and resizes sent back by id. A webview's terminals are
//! killed when its page reloads, since their channels die with it.
//! What runs in each shell is looked up every second (`foreground`) and sent
//! when it changes, for the tab's title.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use sysinfo::{Pid, Process, ProcessRefreshKind, ProcessesToUpdate, System};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Manager, State, Webview};

struct Session {
    /// The webview label that opened it.
    owner: String,
    master: Box<dyn MasterPty + Send>,
    /// Input, written in order by the session's writer thread.
    input: mpsc::Sender<Vec<u8>>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    /// The shell's process id.
    shell: Option<u32>,
    /// What runs in the shell, when it changes: a program's name, or `None`
    /// while the shell itself is in front.
    on_process: Channel<Option<String>>,
    /// The last thing sent on `on_process`.
    process: Option<Option<String>>,
}

#[derive(Default)]
pub struct Terminals {
    next: AtomicU32,
    sessions: Mutex<HashMap<u32, Session>>,
    /// The process table, shared by the poller and `terminal_foreground`.
    system: Mutex<Option<System>>,
    poller: OnceLock<()>,
}

impl Terminals {
    fn take(&self, id: u32) -> Option<Session> {
        self.sessions.lock().unwrap().remove(&id)
    }

    fn kill(&self, id: u32) {
        if let Some(session) = self.sessions.lock().unwrap().get_mut(&id) {
            let _ = session.killer.kill();
        }
    }

    /// Kills every terminal `label` opened.
    pub fn clear(&self, label: &str) {
        for session in self.sessions.lock().unwrap().values_mut() {
            if session.owner == label {
                let _ = session.killer.kill();
            }
        }
    }

    /// Kills every terminal.
    pub fn kill_all(&self) {
        for session in self.sessions.lock().unwrap().values_mut() {
            let _ = session.killer.kill();
        }
    }

    /// Re-reads the process table and runs `f` on it.
    fn with_processes<T>(&self, f: impl FnOnce(&System) -> T) -> Option<T> {
        let mut system = self.system.lock().unwrap();
        if system.is_none() {
            *system = System::new().ok();
        }
        let system = system.as_mut()?;
        system.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing().without_tasks());
        Some(f(system))
    }

    /// Sends each session's foreground process when it has changed.
    fn poll(&self) {
        let shells: Vec<(u32, Option<u32>, Option<i32>)> = {
            let sessions = self.sessions.lock().unwrap();
            sessions.iter().map(|(id, s)| (*id, s.shell, leader(s))).collect()
        };
        if shells.is_empty() {
            return;
        }
        let Some(found) = self.with_processes(|system| {
            shells
                .iter()
                .map(|&(id, shell, leader)| (id, shell.and_then(|shell| foreground(system, shell, leader))))
                .collect::<Vec<_>>()
        }) else {
            return;
        };
        let mut sessions = self.sessions.lock().unwrap();
        for (id, process) in found {
            let Some(session) = sessions.get_mut(&id) else {
                continue;
            };
            if session.process.as_ref() == Some(&process) {
                continue;
            }
            if session.on_process.send(process.clone()).is_ok() {
                session.process = Some(process);
            }
        }
    }

    /// Starts the once-a-second look at what each shell runs.
    fn start_poller(&self, app: &AppHandle) {
        self.poller.get_or_init(|| {
            let app = app.clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(Duration::from_secs(1));
                app.state::<Terminals>().poll();
            });
        });
    }
}

/// The terminal's foreground process group, where the OS keeps one.
#[cfg(unix)]
fn leader(session: &Session) -> Option<i32> {
    session.master.process_group_leader()
}

#[cfg(not(unix))]
fn leader(_session: &Session) -> Option<i32> {
    None
}

/// Shells, looked through for the program they run (`bash` started from
/// `pwsh`, npm's `cmd /c`).
const SHELLS: &[&str] = &["pwsh", "powershell", "cmd", "bash", "zsh", "sh", "fish", "nu", "dash", "ksh", "tcsh", "csh"];

/// Console hosts that can sit under a shell on Windows.
const HOSTS: &[&str] = &["conhost", "openconsole"];

/// A process's name, without `.exe` on Windows.
fn name_of(process: &Process) -> String {
    let name = process.name().to_string_lossy().into_owned();
    if cfg!(windows) && name.to_ascii_lowercase().ends_with(".exe") {
        return name[..name.len() - 4].to_owned();
    }
    name
}

/// What runs in the shell `shell`: `None` while the shell itself is in
/// front, else the program's name (`cargo`, `node`, `vim`). With a foreground
/// process group (unix), its leader; otherwise the newest child, followed
/// down through shells (as VS Code does on Windows).
fn foreground(system: &System, shell: u32, leader: Option<i32>) -> Option<String> {
    let shell = Pid::from_u32(shell);
    if let Some(leader) = leader.and_then(|pid| u32::try_from(pid).ok()).map(Pid::from_u32) {
        if leader == shell {
            return None;
        }
        if let Some(process) = system.process(leader) {
            return Some(name_of(process));
        }
    }

    let mut children: HashMap<Pid, Vec<&Process>> = HashMap::new();
    for process in system.processes().values() {
        if let Some(parent) = process.parent() {
            children.entry(parent).or_default().push(process);
        }
    }
    let mut current = system.process(shell)?;
    // Bounded, in case reused ids make a loop.
    for _ in 0..16 {
        let newest = children
            .get(&current.pid())
            .into_iter()
            .flatten()
            .filter(|p| !HOSTS.contains(&name_of(p).to_ascii_lowercase().as_str()))
            .max_by_key(|p| (p.start_time(), p.pid()));
        let Some(&child) = newest else {
            // A shell started from the shell, at its prompt.
            return (current.pid() != shell).then(|| name_of(current));
        };
        current = child;
        let name = name_of(child);
        if !SHELLS.contains(&name.to_ascii_lowercase().as_str()) {
            return Some(name);
        }
    }
    Some(name_of(current))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalStarted {
    id: u32,
    /// The shell's name, e.g. `pwsh` or `zsh`.
    shell: String,
}

#[cfg(windows)]
fn on_path(exe: &str) -> Option<PathBuf> {
    std::env::split_paths(&std::env::var_os("PATH")?)
        .map(|dir| dir.join(exe))
        .find(|path| path.is_file())
}

/// The user's shell: PowerShell 7, else Windows PowerShell on Windows;
/// `$SHELL` elsewhere (a login shell on macOS, as Terminal.app starts it).
fn shell() -> CommandBuilder {
    #[cfg(windows)]
    {
        let exe = on_path("pwsh.exe").unwrap_or_else(|| PathBuf::from("powershell.exe"));
        let mut cmd = CommandBuilder::new(exe);
        cmd.arg("-NoLogo");
        cmd
    }
    #[cfg(not(windows))]
    {
        let fallback = if cfg!(target_os = "macos") { "/bin/zsh" } else { "/bin/bash" };
        let exe = std::env::var("SHELL")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| fallback.into());
        let mut cmd = CommandBuilder::new(exe);
        if cfg!(target_os = "macos") {
            cmd.arg("-l");
        }
        cmd
    }
}

fn shell_name(cmd: &CommandBuilder) -> String {
    let program = cmd.get_argv().first().map(|s| s.to_string_lossy().into_owned());
    let program = program.unwrap_or_default();
    Path::new(&program)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or(program)
}

/// Starts a shell in `cwd` (the home folder when it's missing or gone).
/// Output arrives on `on_data` as bytes; `on_exit` gets the exit code once
/// the shell has gone and its last output has been sent.
#[tauri::command]
pub async fn terminal_spawn(
    app: AppHandle,
    webview: Webview,
    terminals: State<'_, Terminals>,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
    on_data: Channel<InvokeResponseBody>,
    on_exit: Channel<Option<u32>>,
    on_process: Channel<Option<String>>,
) -> Result<TerminalStarted, String> {
    let size = PtySize { rows: rows.max(1), cols: cols.max(1), pixel_width: 0, pixel_height: 0 };
    let pair = native_pty_system().openpty(size).map_err(|e| e.to_string())?;

    let mut cmd = shell();
    let dir = cwd
        .map(PathBuf::from)
        .filter(|dir| dir.is_dir())
        .or_else(|| app.path().home_dir().ok());
    if let Some(dir) = dir {
        cmd.cwd(dir);
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "Hive");
    let shell = shell_name(&cmd);

    let mut child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    // The child holds its own end; ours would keep the output open past its exit.
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let mut writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let killer = child.clone_killer();
    let shell_pid = child.process_id();

    let (input, inbox) = mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        for bytes in inbox {
            if writer.write_all(&bytes).and_then(|_| writer.flush()).is_err() {
                break;
            }
        }
    });

    let output = std::thread::spawn(move || {
        let mut buf = vec![0u8; 16 * 1024];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if on_data.send(InvokeResponseBody::Raw(buf[..n].to_vec())).is_err() {
                        break;
                    }
                }
            }
        }
    });

    let id = terminals.next.fetch_add(1, Ordering::Relaxed) + 1;
    terminals.sessions.lock().unwrap().insert(
        id,
        Session {
            owner: webview.label().to_owned(),
            master: pair.master,
            input,
            killer,
            shell: shell_pid,
            on_process,
            process: None,
        },
    );
    terminals.start_poller(&app);

    std::thread::spawn(move || {
        let code = child.wait().ok().map(|status| status.exit_code());
        // Dropping the master ends the output (ConPTY keeps it open until then)
        // and the writer thread with it.
        drop(app.state::<Terminals>().take(id));
        let _ = output.join();
        let _ = on_exit.send(code);
    });

    Ok(TerminalStarted { id, shell })
}

/// Types `data` into terminal `id`; in order, without waiting for the shell.
#[tauri::command]
pub fn terminal_write(terminals: State<'_, Terminals>, id: u32, data: Vec<u8>) {
    if let Some(session) = terminals.sessions.lock().unwrap().get(&id) {
        let _ = session.input.send(data);
    }
}

#[tauri::command]
pub fn terminal_resize(terminals: State<'_, Terminals>, id: u32, cols: u16, rows: u16) -> Result<(), String> {
    match terminals.sessions.lock().unwrap().get(&id) {
        Some(session) => session
            .master
            .resize(PtySize { rows: rows.max(1), cols: cols.max(1), pixel_width: 0, pixel_height: 0 })
            .map_err(|e| e.to_string()),
        None => Ok(()),
    }
}

/// What runs in terminal `id`'s shell right now, as `on_process` sends it
/// (`None` while the shell itself is in front, or once it has gone).
#[tauri::command]
pub async fn terminal_foreground(app: AppHandle, id: u32) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let terminals = app.state::<Terminals>();
        let (shell, leader) = {
            let sessions = terminals.sessions.lock().unwrap();
            let session = sessions.get(&id)?;
            (session.shell?, leader(session))
        };
        terminals.with_processes(|system| foreground(system, shell, leader)).flatten()
    })
    .await
    .ok()
    .flatten()
}

/// Kills terminal `id`'s shell; `on_exit` still follows.
#[tauri::command]
pub fn terminal_kill(terminals: State<'_, Terminals>, id: u32) {
    terminals.kill(id);
}
