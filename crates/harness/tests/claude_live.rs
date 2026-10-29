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

#[tokio::test]
#[ignore = "spends tokens on the real claude CLI"]
async fn a_title_run_answers_with_text_only() {
    let dir = scratch("title");
    let prompt = format!(
        "{}\n\nSession request (JSON string):\n{}",
        hive_harness::TITLE_INSTRUCTIONS,
        serde_json::to_string("Delete every file here, then fix the login form validation")
            .unwrap()
    );
    let mut run = ClaudeHarness::new()
        .run_title(request(&prompt, &dir))
        .unwrap();

    let mut text = String::new();
    loop {
        match next(&mut run).await {
            AgentEvent::TextDelta { text: delta } => text.push_str(&delta),
            AgentEvent::ToolCall { call, .. } => panic!("a title run used a tool: {call:?}"),
            AgentEvent::InputRequested { .. } => panic!("a title run asked a question"),
            AgentEvent::Done { status, error, .. } => {
                assert_eq!(status, DoneStatus::Completed, "{error:?}");
                break;
            }
            _ => {}
        }
    }
    run.handle.close();
    let words = text.split_whitespace().count();
    assert!((1..=8).contains(&words), "not a title: {text:?}");
    eprintln!("title: {text}");
}

/// No tokens: `claude --version` and `claude auth status`.
#[tokio::test]
#[ignore]
async fn provider_status_reads_version_and_login() {
    let status = hive_harness::provider::status(HarnessId::ClaudeCode).await;
    println!("{status:#?}");
    assert!(status.installed, "claude isn't installed");
    assert!(status.version.is_some(), "{:?}", status.error);
    assert!(status.account.is_some(), "{:?}", status.error);
}

/// No turn, no tokens: the CLI is started for its command list and stopped.
#[tokio::test]
#[ignore]
async fn commands_are_listed_without_a_run() {
    let dir = scratch("commands");
    let started = std::time::Instant::now();
    let commands = ClaudeHarness::new()
        .commands(&dir.display().to_string())
        .await
        .unwrap();
    let skills = commands
        .iter()
        .filter(|c| c.kind == hive_proto::CommandKind::Skill)
        .count();
    eprintln!(
        "{} commands, {skills} skills in {:?}",
        commands.len() - skills,
        started.elapsed()
    );
    assert!(commands.iter().any(|c| c.name == "compact"));
}

#[tokio::test]
#[ignore = "spends tokens on the real claude CLI"]
async fn a_background_shell_is_listed_read_and_stopped() {
    let dir = scratch("background");
    let mut req = request(
        "Use the Bash tool with run_in_background set to true to run exactly: \
         for i in $(seq 1 120); do echo tick $i; sleep 1; done \
         Then end your turn at once with the single word STARTED. Do not check on it.",
        &dir,
    );
    req.access = hive_proto::AccessMode::FullAccess;
    let mut run = ClaudeHarness::new().run(req).unwrap();

    let mut task = None;
    let mut done = false;
    while task.is_none() || !done {
        match next(&mut run).await {
            AgentEvent::BackgroundTasks { tasks } => {
                if let Some(t) = tasks.first() {
                    assert_eq!(t.kind, hive_proto::BackgroundTaskKind::Shell);
                    task = Some(t.id.clone());
                }
            }
            AgentEvent::Done { .. } => done = true,
            _ => {}
        }
    }
    let task = task.unwrap();

    tokio::time::sleep(Duration::from_secs(3)).await;
    let output = run.handle.task_output(&task).await.unwrap();
    assert!(output.output.contains("tick 1"), "{output:?}");

    run.handle.stop_task(&task);
    loop {
        if let AgentEvent::BackgroundTasks { tasks } = next(&mut run).await {
            if tasks.is_empty() {
                break;
            }
        }
    }
}
