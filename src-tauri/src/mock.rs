//! Streams `hive_harness::MockHarness`'s scripted turn to the webview, so the
//! transcript UI can be built without spending tokens.

use std::time::Duration;

use hive_harness::{Harness, MockHarness};
use hive_proto::{AgentEvent, RunRequest, UserInputAnswer};
use tauri::ipc::Channel;

#[tauri::command]
pub async fn mock_run(request: RunRequest, on_event: Channel<AgentEvent>) -> Result<(), String> {
    let mut run = MockHarness::new().run(request).map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn(async move {
        while let Some(event) = run.events.recv().await {
            match &event {
                // Nothing in the UI answers questions yet: take the first
                // option after a beat.
                AgentEvent::InputRequested {
                    request_id,
                    questions,
                } => {
                    let handle = run.handle.clone();
                    let request_id = request_id.clone();
                    let answers = questions
                        .iter()
                        .map(|q| UserInputAnswer {
                            question_id: q.id.clone(),
                            labels: q.options.iter().take(1).cloned().collect(),
                        })
                        .collect();
                    tauri::async_runtime::spawn(async move {
                        tokio::time::sleep(Duration::from_millis(1500)).await;
                        handle.answer(request_id, answers);
                    });
                }
                AgentEvent::Done { .. } => run.handle.close(),
                _ => {}
            }
            if on_event.send(event).is_err() {
                // The webview went away (reload, window closed).
                return;
            }
        }
    });
    Ok(())
}
