//! Chat commands. A run's events are broadcast as [`EVENT`], tagged with the
//! id the frontend gave it, so its listener is in place before the first one.

use std::path::Path;

use outcode_proto::{AgentEvent, RunRequest};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::settings::SettingsFile;

const EVENT: &str = "chat://event";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RunEvent {
    run_id: String,
    event: AgentEvent,
}

/// Starts Claude on `request`; its events follow as [`EVENT`]s, ending with
/// `done`. Fails only when Claude can't be started.
#[tauri::command]
pub async fn chat_send(
    app: AppHandle,
    file: State<'_, SettingsFile>,
    run_id: String,
    request: RunRequest,
) -> Result<(), String> {
    let binary = file.get().claude.binary_path;
    let binary = (!binary.is_empty()).then(|| Path::new(&binary));
    let mut run = outcode_harness::claude::run(request, binary).map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn(async move {
        while let Some(event) = run.events.recv().await {
            let _ = app.emit(
                EVENT,
                RunEvent {
                    run_id: run_id.clone(),
                    event,
                },
            );
        }
    });
    Ok(())
}
