//! Runs the real `opencode` CLI (2.x) on its default model, so it spends a
//! few tokens. Ignored by default:
//!
//!     cargo test -p hive-harness --test opencode_live -- --ignored --test-threads 1

use std::time::Duration;

use hive_harness::{Harness, OpencodeHarness, Run};
use hive_proto::{AccessMode, AgentEvent, DoneStatus, HarnessId, RunRequest, SandboxLevel, ToolCall};

fn request(prompt: &str, cwd: &std::path::Path) -> RunRequest {
    RunRequest {
        harness: HarnessId::Opencode,
        prompt: prompt.into(),
        cwd: cwd.display().to_string(),
        sandbox: SandboxLevel::WorkspaceWrite,
        model: None,
        reasoning: None,
        model_options: Default::default(),
        auto_approve: false,
        access: AccessMode::FullAccess,
        plan: false,
        resume: None,
        attachments: Vec::new(),
    }
}

fn scratch(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("hive-opencode-{name}"));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

async fn next(run: &mut Run) -> AgentEvent {
    tokio::time::timeout(Duration::from_secs(180), run.events.recv())
        .await
        .expect("no event within 3 minutes")
        .expect("stream ended early")
}

/// Text until `Done`, and the done status and session.
async fn turn(run: &mut Run) -> (String, DoneStatus, Option<String>) {
    let mut text = String::new();
    loop {
        match next(run).await {
            AgentEvent::TextDelta { text: t } => text.push_str(&t),
            AgentEvent::Done {
                status,
                session_id,
                error,
            } => {
                assert_ne!(status, DoneStatus::Errored, "{error:?}");
                return (text, status, session_id);
            }
            _ => {}
        }
    }
}

#[tokio::test]
#[ignore = "starts the real opencode CLI"]
async fn catalog_lists_models() {
    let harness = OpencodeHarness::new();
    assert!(harness.catalog().installed);
    // The first call starts the fetch.
    for _ in 0..60 {
        let catalog = harness.catalog();
        if !catalog.models.is_empty() {
            assert!(catalog.default_model.is_some());
            return;
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    panic!("no models listed within a minute");
}

#[tokio::test]
#[ignore = "spends tokens on the real opencode CLI"]
async fn a_resumed_session_remembers() {
    let dir = scratch("resume");
    let mut run = OpencodeHarness::new()
        .run(request("Remember the word PELICAN. Reply with just OK.", &dir))
        .unwrap();
    let (_, status, session) = turn(&mut run).await;
    assert_eq!(status, DoneStatus::Completed);
    run.handle.close();
    while run.events.recv().await.is_some() {}

    let mut resumed = request("Which word did I ask you to remember? Reply with just the word.", &dir);
    resumed.resume = session;
    let mut run = OpencodeHarness::new().run(resumed).unwrap();
    let (text, _, _) = turn(&mut run).await;
    assert!(text.to_uppercase().contains("PELICAN"), "{text}");
}

#[tokio::test]
#[ignore = "spends tokens on the real opencode CLI"]
async fn an_interrupted_turn_ends_interrupted() {
    let dir = scratch("interrupt");
    let mut run = OpencodeHarness::new()
        .run(request(
            "Run the shell command `sleep 60`, then say done.",
            &dir,
        ))
        .unwrap();
    loop {
        if let AgentEvent::ToolCall {
            call: ToolCall::Exec { .. },
            ..
        } = next(&mut run).await
        {
            break;
        }
    }
    tokio::time::sleep(Duration::from_secs(2)).await;
    run.handle.interrupt();
    loop {
        if let AgentEvent::Done { status, .. } = next(&mut run).await {
            assert_eq!(status, DoneStatus::Interrupted);
            break;
        }
    }
    // The session takes another prompt.
    run.handle.send("Reply with just OK.");
    let (_, status, _) = turn(&mut run).await;
    assert_eq!(status, DoneStatus::Completed);
}

#[tokio::test]
#[ignore = "spends tokens on the real opencode CLI"]
async fn a_title_run_writes_text() {
    let dir = scratch("title");
    let mut run = OpencodeHarness::new()
        .run_title(request(
            "Write a 3 word title for this request: fix the login page crash",
            &dir,
        ))
        .unwrap();
    let (text, status, _) = turn(&mut run).await;
    assert_eq!(status, DoneStatus::Completed);
    assert!(!text.trim().is_empty());
}
