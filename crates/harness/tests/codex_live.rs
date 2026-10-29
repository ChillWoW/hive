//! Runs the real `codex` CLI on the account's default model at low effort,
//! so it spends a few tokens. Ignored by default:
//!
//!     cargo test -p hive-harness --test codex_live -- --ignored --test-threads 1

use std::time::Duration;

use hive_harness::{CodexHarness, Harness, Run};
use hive_proto::{
    AccessMode, AgentEvent, DoneStatus, HarnessId, ReasoningLevel, RunRequest, SandboxLevel,
    ToolCall, UserInputAnswer,
};

fn request(prompt: &str, cwd: &std::path::Path) -> RunRequest {
    RunRequest {
        harness: HarnessId::Codex,
        prompt: prompt.into(),
        cwd: cwd.display().to_string(),
        sandbox: SandboxLevel::WorkspaceWrite,
        model: CodexHarness::new().catalog().default_model,
        reasoning: Some(ReasoningLevel::Low),
        model_options: Default::default(),
        auto_approve: false,
        access: AccessMode::FullAccess,
        plan: false,
        resume: None,
        attachments: Vec::new(),
        mcp: None,
    }
}

fn scratch(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("hive-codex-{name}"));
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
#[ignore = "spends tokens on the real codex CLI"]
async fn catalog_lists_models() {
    let catalog = CodexHarness::new().catalog();
    assert!(catalog.installed);
    assert!(!catalog.models.is_empty());
    assert!(catalog.default_model.is_some());
}

#[tokio::test]
#[ignore = "spends tokens on the real codex CLI"]
async fn a_resumed_thread_remembers() {
    let dir = scratch("resume");
    let mut run = CodexHarness::new()
        .run(request(
            "Remember the word PELICAN. Reply with just OK.",
            &dir,
        ))
        .unwrap();
    let (_, _, session) = turn(&mut run).await;
    run.handle.close();
    while run.events.recv().await.is_some() {}

    let mut resumed = request(
        "What word did I ask you to remember? Reply with just it.",
        &dir,
    );
    resumed.resume = session.clone();
    let mut run = CodexHarness::new().run(resumed).unwrap();
    let (text, status, again) = turn(&mut run).await;
    assert_eq!(status, DoneStatus::Completed);
    assert_eq!(again, session);
    assert!(text.to_uppercase().contains("PELICAN"), "{text}");
}

#[tokio::test]
#[ignore = "spends tokens on the real codex CLI"]
async fn interrupt_ends_the_turn_and_the_session_takes_another() {
    let dir = scratch("interrupt");
    let mut run = CodexHarness::new()
        .run(request(
            "Write the numbers from 1 to 400 as English words, one per line, no other text.",
            &dir,
        ))
        .unwrap();
    loop {
        if let AgentEvent::TextDelta { .. } = next(&mut run).await {
            run.handle.interrupt();
            break;
        }
    }
    loop {
        if let AgentEvent::Done { status, .. } = next(&mut run).await {
            assert_eq!(status, DoneStatus::Interrupted);
            break;
        }
    }
    run.handle.send("Reply with just the word pong.");
    let (text, status, _) = turn(&mut run).await;
    assert_eq!(status, DoneStatus::Completed);
    assert!(text.to_lowercase().contains("pong"), "{text}");
}

#[tokio::test]
#[ignore = "spends tokens on the real codex CLI"]
async fn supervised_asks_and_a_refusal_stops_the_command() {
    let dir = scratch("deny");
    let mut req = request(
        "Run exactly this shell command: git init. If it is declined, reply with the single word DECLINED.",
        &dir,
    );
    req.access = AccessMode::Supervised;
    let mut run = CodexHarness::new().run(req).unwrap();
    let mut asked = false;
    loop {
        match next(&mut run).await {
            AgentEvent::InputRequested {
                request_id,
                questions,
            } => {
                assert_eq!(questions[0].header, "Approve command");
                asked = true;
                run.handle.answer(
                    request_id,
                    vec![UserInputAnswer {
                        question_id: questions[0].id.clone(),
                        labels: vec!["No".into()],
                    }],
                );
            }
            AgentEvent::ToolResult { is_error, .. } if asked => assert!(is_error),
            AgentEvent::Done { status, .. } => {
                assert_eq!(status, DoneStatus::Completed);
                break;
            }
            _ => {}
        }
    }
    assert!(asked, "codex never asked");
    assert!(!dir.join(".git").exists());
}

#[tokio::test]
#[ignore = "spends tokens on the real codex CLI"]
async fn full_access_runs_commands_and_edits() {
    let dir = scratch("edit");
    std::fs::write(dir.join("a.txt"), "hello\n").unwrap();
    let mut run = CodexHarness::new()
        .run(request(
            "Change a.txt so it says exactly `hello world`, then reply with just done.",
            &dir,
        ))
        .unwrap();
    let mut changed = false;
    loop {
        match next(&mut run).await {
            AgentEvent::ToolCall { call, .. } => {
                changed |= matches!(
                    call,
                    ToolCall::EditFile { .. }
                        | ToolCall::WriteFile { .. }
                        | ToolCall::ApplyPatch { .. }
                        | ToolCall::Exec { .. }
                );
            }
            AgentEvent::InputRequested { .. } => panic!("full access asked"),
            AgentEvent::Done { status, error, .. } => {
                assert_eq!(status, DoneStatus::Completed, "{error:?}");
                break;
            }
            _ => {}
        }
    }
    assert!(changed);
    let text = std::fs::read_to_string(dir.join("a.txt")).unwrap();
    assert!(text.contains("hello world"), "{text}");
}

#[tokio::test]
#[ignore = "starts the real codex CLI"]
async fn lists_skills_and_commands() {
    let dir = scratch("commands");
    let commands = CodexHarness::new()
        .commands(&dir.display().to_string())
        .await
        .unwrap();
    assert!(commands.iter().any(|c| c.name == "compact"));
}

#[tokio::test]
#[ignore = "starts the real codex CLI"]
async fn provider_status_reads_version_and_account() {
    let status = hive_harness::provider::status(HarnessId::Codex).await;
    assert!(status.installed, "{status:?}");
    assert!(status.version.is_some(), "{status:?}");
    assert!(status.account.is_some(), "{status:?}");
    assert!(status.error.is_none(), "{status:?}");
    let usage = hive_harness::provider::usage(HarnessId::Codex).await;
    assert!(usage.is_ok(), "{usage:?}");
}

#[tokio::test]
#[ignore = "spends tokens on the real codex CLI"]
async fn writes_a_title() {
    let dir = scratch("title");
    let harness = CodexHarness::new();
    let mut req = request(
        "Session request: fix the login redirect bug in the auth module",
        &dir,
    );
    req.reasoning = Some(ReasoningLevel::Low);
    let mut run = harness.run_title(req).unwrap();
    let (text, status, _) = turn(&mut run).await;
    assert_eq!(status, DoneStatus::Completed);
    let words = text.split_whitespace().count();
    assert!((1..=8).contains(&words), "{text}");
}
