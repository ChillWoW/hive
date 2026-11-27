//! Terminal commands over [`Terminals`]: the user's shell in a pty, its
//! output streamed to the page as raw bytes over a channel, input (raw bytes
//! too) and resizes sent back by id. A webview's terminals are hung up when
//! its page reloads, since their channels die with it, and all of them when
//! the app exits.

use std::path::PathBuf;

use outcode_harness::claude::{parse_env, split_args};
use outcode_terminal::{Shell, Sink, Terminals};
use serde::Serialize;
use tauri::ipc::{Channel, InvokeBody, InvokeResponseBody, Request};
use tauri::{AppHandle, State, Webview};

use crate::settings::{SettingsFile, TerminalSettings};

/// The header naming the terminal a `terminal_write` is for.
const ID_HEADER: &str = "x-terminal-id";

struct Channels {
    data: Channel<InvokeResponseBody>,
    process: Channel<Option<String>>,
    exit: Channel<Option<u32>>,
}

impl Sink for Channels {
    fn data(&self, bytes: Vec<u8>) -> bool {
        self.data.send(InvokeResponseBody::Raw(bytes)).is_ok()
    }

    fn process(&self, name: Option<String>) -> bool {
        self.process.send(name).is_ok()
    }

    fn exit(&self, code: Option<u32>) {
        let _ = self.exit.send(code);
    }
}

/// The shell `terminal.*` settings describe, started in `cwd`.
fn shell(app: &AppHandle, settings: &TerminalSettings, cwd: Option<String>) -> Shell {
    Shell {
        program: settings.shell.clone(),
        args: (!settings.shell_args.is_empty()).then(|| split_args(&settings.shell_args)),
        env: parse_env(&settings.env),
        cwd: cwd.filter(|dir| !dir.is_empty()).map(PathBuf::from),
        term_program: Some(("Outcode".into(), app.package_info().version.to_string())),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalStarted {
    id: u32,
    /// The shell's name, e.g. `zsh` or `pwsh`.
    shell: String,
}

/// Starts the `terminal.shell` setting's shell in `cwd` (the home folder when
/// it's missing or gone). Output arrives on `on_data` as bytes; `on_process`
/// gets what runs in front whenever that changes (`None`: the shell itself);
/// `on_exit` gets the exit code (`None` for a signal) once the shell has gone
/// and its last output has been sent.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn terminal_spawn(
    app: AppHandle,
    webview: Webview,
    terminals: State<'_, Terminals>,
    settings: State<'_, SettingsFile>,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
    on_data: Channel<InvokeResponseBody>,
    on_process: Channel<Option<String>>,
    on_exit: Channel<Option<u32>>,
) -> Result<TerminalStarted, String> {
    let shell = shell(&app, &settings.get().terminal, cwd);
    let channels = Channels {
        data: on_data,
        process: on_process,
        exit: on_exit,
    };
    let started = terminals
        .spawn(webview.label(), &shell, cols, rows, channels)
        .map_err(|e| e.to_string())?;
    Ok(TerminalStarted {
        id: started.id,
        shell: started.shell,
    })
}

/// Types the request's raw body into the terminal its `x-terminal-id` header
/// names; in order, without waiting for the shell.
#[tauri::command]
pub fn terminal_write(request: Request<'_>, terminals: State<'_, Terminals>) -> Result<(), String> {
    let id = request
        .headers()
        .get(ID_HEADER)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse().ok())
        .ok_or("no terminal id")?;
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected raw bytes".into());
    };
    terminals.write(id, bytes.clone());
    Ok(())
}

#[tauri::command]
pub fn terminal_resize(terminals: State<'_, Terminals>, id: u32, cols: u16, rows: u16) -> Result<(), String> {
    terminals.resize(id, cols, rows).map_err(|e| e.to_string())
}

/// What runs in front of terminal `id` right now, as `on_process` reports it.
#[tauri::command]
pub async fn terminal_foreground(terminals: State<'_, Terminals>, id: u32) -> Result<Option<String>, String> {
    let terminals = terminals.inner().clone();
    tauri::async_runtime::spawn_blocking(move || terminals.foreground(id))
        .await
        .map_err(|e| e.to_string())
}

/// Hangs up terminal `id`; `on_exit` still follows.
#[tauri::command]
pub fn terminal_kill(terminals: State<'_, Terminals>, id: u32) {
    terminals.kill(id);
}
