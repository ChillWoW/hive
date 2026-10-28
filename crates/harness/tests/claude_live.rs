//! Runs the real `claude` CLI on Haiku, so it spends a few tokens. Ignored by
//! default:
//!
//!     cargo test -p hive-harness --test claude_live -- --ignored --test-threads 1

use std::time::Duration;

use hive_harness::{ClaudeHarness, Harness, Run};
use hive_proto::{
    AgentEvent, DoneStatus, HarnessId, RunRequest, SandboxLevel, ToolCall, UserInputAnswer,
};

fn request(prompt: &str, cwd: &std::path::Path) -> RunRequest {
    RunRequest {
        harness: HarnessId::ClaudeCode,
        prompt: prompt.into(),
        cwd: cwd.display().to_string(),
        sandbox: SandboxLevel::WorkspaceWrite,
        model: Some("haiku".into()),
        reasoning: None,
        model_options: Default::default(),
        auto_approve: false,
        access: Default::default(),
        plan: false,
        resume: None,
        attachments: Vec::new(),
    }
}

fn scratch(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("hive-harness-{name}"));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

async fn next(run: &mut Run) -> AgentEvent {
    tokio::time::timeout(Duration::from_secs(120), run.events.recv())
        .await
        .expect("no event within 2 minutes")
        .expect("stream ended early")
}

#[tokio::test]
#[ignore = "spends tokens on the real claude CLI"]
async fn denied_permission_is_reported_and_the_file_is_not_written() {
    let dir = scratch("deny");
    let mut run = ClaudeHarness::new()
        .run(request(
            "Use the Bash tool to run exactly: curl -s https://example.com -o page.html \
             If it is denied, reply with the single word DENIED.",
            &dir,
        ))
        .unwrap();

    let mut asked = false;
    loop {
        match next(&mut run).await {
            AgentEvent::InputRequested {
                request_id,
                questions,
            } => {
                assert_eq!(questions[0].header, "Permission");
                assert!(questions[0].question.starts_with("Allow Bash"));
                asked = true;
                run.handle.answer(
                    request_id,
                    vec![UserInputAnswer {
                        question_id: questions[0].id.clone(),
                        labels: vec!["Deny".into()],
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
    assert!(asked, "the CLI never asked for permission");
    assert!(!dir.join("page.html").exists());
}

#[tokio::test]
#[ignore = "spends tokens on the real claude CLI"]
async fn interrupt_ends_the_turn_and_the_session_takes_another() {
    let dir = scratch("interrupt");
    let mut run = ClaudeHarness::new()
        .run(request(
            "Count slowly from 1 to 300, one number per line, no other text.",
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
    let mut text = String::new();
    loop {
        match next(&mut run).await {
            AgentEvent::TextDelta { text: delta } => text.push_str(&delta),
            AgentEvent::ToolCall {
                call: ToolCall::Exec { .. },
                ..
            } => panic!("unexpected tool call"),
            AgentEvent::Done { status, .. } => {
                assert_eq!(status, DoneStatus::Completed);
                break;
            }
            _ => {}
        }
    }
    assert!(text.to_lowercase().contains("pong"), "got {text:?}");

    run.handle.close();
    assert!(tokio::time::timeout(Duration::from_secs(30), async {
        while run.events.recv().await.is_some() {}
    })
    .await
    .is_ok());
}
