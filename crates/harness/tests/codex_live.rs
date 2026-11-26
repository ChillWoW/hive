//! Against the installed `codex`, on the account's default model at low
//! effort, so it spends a few tokens:
//!
//!     cargo test -p outcode-harness --test codex_live -- --ignored --test-threads 1

use std::time::Duration;

use outcode_harness::codex::{Codex, Options};
use outcode_harness::{Harness, Run};
use outcode_proto::{
    AccessMode, AgentEvent, ApprovalDecision, ChatConfig, DoneStatus, InputRequest, InputResponse, ReasoningLevel,
    RunRequest, ToolCall,
};

fn codex() -> Codex {
    Codex::new(Options::default)
}

fn request(prompt: &str, cwd: &std::path::Path) -> RunRequest {
    RunRequest {
        prompt: prompt.into(),
        cwd: cwd.display().to_string(),
        config: ChatConfig {
            model: codex().catalog().default_model,
            reasoning: Some(ReasoningLevel::Low),
            access: AccessMode::FullAccess,
            ..ChatConfig::default()
        },
        ..RunRequest::default()
    }
}

fn scratch(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("outcode-codex-{name}"));
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

/// The turn's text, its end and its session.
async fn turn(run: &mut Run) -> (String, DoneStatus, Option<String>) {
    let mut text = String::new();
    let mut session = None;
    let mut error = None;
    loop {
        match next(run).await {
            AgentEvent::SessionStarted { session_id } => session = Some(session_id),
            AgentEvent::TextDelta { text: t } => text.push_str(&t),
            AgentEvent::Error { message } => error = Some(message),
            AgentEvent::Done { status } => {
                assert_ne!(status, DoneStatus::Errored, "{error:?}");
                return (text, status, session);
            }
            _ => {}
        }
    }
}

#[tokio::test]
#[ignore = "starts the real codex CLI"]
async fn catalog_lists_models() {
    let codex = codex();
    let catalog = codex.catalog();
    assert!(catalog.installed);
    assert!(!catalog.models.is_empty(), "{catalog:?}");
    assert!(catalog.default_model.is_some());
}

#[tokio::test]
#[ignore = "spends tokens on the real codex CLI"]
async fn plain_prompt_then_a_resumed_thread_remembers() {
    let dir = scratch("resume");
    let mut run = codex()
        .run(request("Remember the word PELICAN. Reply with just OK.", &dir))
        .unwrap();
    let (text, status, session) = turn(&mut run).await;
    assert_eq!(status, DoneStatus::Completed);
    assert!(!text.is_empty());
    assert!(session.is_some());
    run.handle.close();
    while run.events.recv().await.is_some() {}

    let mut resumed = request("What word did I ask you to remember? Reply with just it.", &dir);
    resumed.resume = session.clone();
    let mut run = codex().run(resumed).unwrap();
    let (text, status, again) = turn(&mut run).await;
    assert_eq!(status, DoneStatus::Completed);
    assert_eq!(again, session);
    assert!(text.to_uppercase().contains("PELICAN"), "{text}");
}

#[tokio::test]
#[ignore = "spends tokens on the real codex CLI"]
async fn interrupt_ends_the_turn_and_the_session_takes_another() {
    let dir = scratch("interrupt");
    let mut run = codex()
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
        if let AgentEvent::Done { status } = next(&mut run).await {
            assert_eq!(status, DoneStatus::Interrupted);
            break;
        }
    }
    run.handle.send("Reply with just the word pong.", Vec::new());
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
    req.config.access = AccessMode::Supervised;
    let mut run = codex().run(req).unwrap();
    let mut asked = false;
    loop {
        match next(&mut run).await {
            AgentEvent::InputRequested { request_id, request } => {
                assert!(
                    matches!(&request, InputRequest::Approval { title, call: Some(ToolCall::Exec { command }), .. }
                        if title == "Run command" && command.contains("git init")),
                    "{request:?}"
                );
                asked = true;
                run.handle.answer(
                    request_id,
                    InputResponse::Approval {
                        decision: ApprovalDecision::Deny,
                    },
                );
            }
            AgentEvent::Done { status } => {
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
    let mut run = codex()
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
                    ToolCall::EditFile { .. } | ToolCall::WriteFile { .. } | ToolCall::Exec { .. }
                );
            }
            AgentEvent::InputRequested { .. } => panic!("full access asked"),
            AgentEvent::Done { status } => {
                assert_eq!(status, DoneStatus::Completed);
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
    let commands = codex().commands(&dir.display().to_string()).await.unwrap();
    assert!(commands.iter().any(|c| c.name == "compact"));
}

#[tokio::test]
#[ignore = "spends tokens on the real codex CLI"]
async fn writes_a_title() {
    let codex = codex();
    let model = codex.catalog().default_model;
    let mut run = codex
        .run_text(
            "Write a title for this session. Return only a concise 3-5 word title.\n\n\
             Session request: fix the login redirect bug in the auth module"
                .into(),
            model.as_deref(),
        )
        .unwrap();
    let (text, status, _) = turn(&mut run).await;
    assert_eq!(status, DoneStatus::Completed);
    let words = text.split_whitespace().count();
    assert!((1..=8).contains(&words), "{text}");
}

#[tokio::test]
#[ignore = "spends tokens on the real codex CLI"]
async fn plan_mode_asks_and_an_approved_plan_is_implemented() {
    let dir = scratch("plan");
    let mut req = request(
        "Plan creating a file named plan.txt containing exactly the word ready. Keep the plan to one step.",
        &dir,
    );
    req.config.plan = true;
    let mut run = codex().run(req).unwrap();
    let mut planned = false;
    loop {
        match next(&mut run).await {
            AgentEvent::InputRequested { request_id, request: InputRequest::Plan { plan } } => {
                assert!(plan.contains("plan.txt"), "{plan}");
                planned = true;
                run.handle.answer(request_id, InputResponse::Plan { approve: true, feedback: None });
            }
            AgentEvent::InputRequested { request, .. } => panic!("asked {request:?}"),
            AgentEvent::Done { status } => {
                assert_eq!(status, DoneStatus::Completed);
                break;
            }
            _ => {}
        }
    }
    assert!(planned, "no plan was offered");
    let text = std::fs::read_to_string(dir.join("plan.txt")).unwrap();
    assert!(text.contains("ready"), "{text}");
}

#[tokio::test]
#[ignore = "spends tokens on the real codex CLI"]
async fn a_completed_turn_is_followed_by_a_prompt_suggestion() {
    let dir = scratch("suggestion");
    let request = request(
        "I'm building a todo app in React. Give me a three-step plan in three short lines. Don't use tools.",
        &dir,
    );
    let codex = Codex::new(|| Options {
        prompt_suggestions: true,
        ..Options::default()
    });
    let mut run = codex.run(request).unwrap();
    let (_, status, _) = turn(&mut run).await;
    assert_eq!(status, DoneStatus::Completed);
    loop {
        if let AgentEvent::PromptSuggestion { text } = next(&mut run).await {
            assert!(!text.trim().is_empty());
            eprintln!("suggestion: {text}");
            break;
        }
    }
    run.handle.close();
}
