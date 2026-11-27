//! Against the installed `agy`, on its cheapest model (Gemini Flash at low
//! thinking) with one-word replies, so it spends little quota:
//!
//!     cargo test -p outcode-harness --test antigravity_live -- --ignored --test-threads 1

use std::time::Duration;

use outcode_harness::antigravity::{Antigravity, Options};
use outcode_harness::{Harness, Run};
use outcode_proto::{
    AccessMode, AgentEvent, ApprovalDecision, ChatConfig, DoneStatus, HarnessId, InputRequest, InputResponse,
    ReasoningLevel, RunRequest, ToolCall,
};

/// The cheapest model agy lists.
const MODEL: &str = "gemini-3.8-flash";

fn agy() -> Antigravity {
    Antigravity::new(Options::default)
}

fn request(prompt: &str, cwd: &std::path::Path, access: AccessMode) -> RunRequest {
    RunRequest {
        prompt: prompt.into(),
        cwd: cwd.display().to_string(),
        config: ChatConfig {
            harness: HarnessId::Antigravity,
            model: Some(MODEL.into()),
            reasoning: Some(ReasoningLevel::Low),
            access,
            ..ChatConfig::default()
        },
        ..RunRequest::default()
    }
}

fn scratch(name: &str) -> std::path::PathBuf {
    // Not the system temp folder, where agy writes without asking.
    let dir = std::path::Path::new(env!("CARGO_TARGET_TMPDIR")).join(format!("outcode-agy-{name}"));
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

/// The turn's text, its end, its session, and every event.
async fn turn(run: &mut Run) -> (String, DoneStatus, Option<String>, Vec<AgentEvent>) {
    let mut text = String::new();
    let mut session = None;
    let mut error = None;
    let mut events = Vec::new();
    loop {
        let event = next(run).await;
        println!("{event:?}");
        match &event {
            AgentEvent::SessionStarted { session_id } => session = Some(session_id.clone()),
            AgentEvent::TextDelta { text: t } => text.push_str(t),
            AgentEvent::Error { message } => error = Some(message.clone()),
            AgentEvent::Done { status } => {
                assert_ne!(*status, DoneStatus::Errored, "{error:?}");
                return (text, *status, session, events);
            }
            _ => {}
        }
        events.push(event);
    }
}

#[tokio::test]
#[ignore = "starts the real agy CLI"]
async fn catalog_lists_models() {
    let agy = agy();
    agy.catalog();
    // The list arrives in the background.
    for _ in 0..60 {
        let catalog = agy.catalog();
        if !catalog.models.is_empty() {
            println!("{catalog:?}");
            assert!(catalog.installed);
            assert!(catalog.models.iter().any(|m| m.id == MODEL), "{catalog:?}");
            return;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    panic!("no models listed");
}

#[tokio::test]
#[ignore = "spends a little quota on the real agy CLI"]
async fn prompt_follow_up_then_a_resumed_session_remembers() {
    let dir = scratch("resume");
    let mut run = agy()
        .run(request("Remember the word: kiwi. Reply with only: ok", &dir, AccessMode::FullAccess))
        .unwrap();
    let (text, status, session, events) = turn(&mut run).await;
    assert_eq!(status, DoneStatus::Completed);
    assert!(!text.trim().is_empty());
    assert!(events.iter().any(|e| matches!(e, AgentEvent::Usage { .. })));
    let session = session.expect("a session id");

    run.handle.send("Reply with only the word I asked you to remember.", Vec::new());
    let (text, ..) = turn(&mut run).await;
    assert!(text.to_lowercase().contains("kiwi"), "{text}");
    run.handle.close();

    let mut resumed = request("Reply with only the word I asked you to remember.", &dir, AccessMode::FullAccess);
    resumed.resume = Some(session.clone());
    let mut run = agy().run(resumed).unwrap();
    let (text, _, again, events) = turn(&mut run).await;
    assert!(!events.iter().any(|e| matches!(e, AgentEvent::Error { .. })), "resumed without a note");
    assert_eq!(again.as_deref(), Some(session.as_str()));
    assert!(text.to_lowercase().contains("kiwi"), "{text}");
    run.handle.close();
}

#[tokio::test]
#[ignore = "spends a little quota on the real agy CLI"]
async fn supervised_writes_ask_and_a_denial_stops_them() {
    let dir = scratch("approve");
    let mut run = agy()
        .run(request(
            "Create a file named b.txt containing the word bye. Then reply with one word.",
            &dir,
            AccessMode::Supervised,
        ))
        .unwrap();
    let mut asked = false;
    loop {
        let event = next(&mut run).await;
        println!("{event:?}");
        match event {
            AgentEvent::InputRequested {
                request_id,
                request: InputRequest::Approval { call, .. },
            } => {
                assert!(matches!(call, Some(ToolCall::WriteFile { .. } | ToolCall::EditFile { .. })), "{call:?}");
                asked = true;
                run.handle.answer(
                    request_id,
                    InputResponse::Approval {
                        decision: ApprovalDecision::Deny,
                    },
                );
            }
            AgentEvent::Done { status } => {
                assert_ne!(status, DoneStatus::Errored);
                break;
            }
            _ => {}
        }
    }
    assert!(asked, "the write was asked about");
    assert!(!dir.join("b.txt").exists(), "a denied write isn't made");
    run.handle.close();
}

#[tokio::test]
#[ignore = "spends a little quota on the real agy CLI"]
async fn interrupt_stops_the_turn_and_the_session_goes_on() {
    let dir = scratch("interrupt");
    let mut run = agy()
        .run(request("Count from 1 to 300, one number per line, nothing else.", &dir, AccessMode::FullAccess))
        .unwrap();
    loop {
        match next(&mut run).await {
            AgentEvent::TextDelta { .. } => {
                run.handle.interrupt();
                break;
            }
            AgentEvent::Done { status } => panic!("ended before it could be stopped: {status:?}"),
            _ => {}
        }
    }
    let status = loop {
        if let AgentEvent::Done { status } = next(&mut run).await {
            break status;
        }
    };
    assert_eq!(status, DoneStatus::Interrupted);
    run.handle.send("Reply with only: ok", Vec::new());
    let (text, status, ..) = turn(&mut run).await;
    assert_eq!(status, DoneStatus::Completed);
    assert!(!text.trim().is_empty());
    run.handle.close();
}

#[tokio::test]
#[ignore = "spends a little quota on the real agy CLI"]
async fn a_subagents_calls_nest_under_its_launch() {
    let dir = scratch("subagent");
    std::fs::write(dir.join("a.py"), "print('hi')\n").unwrap();
    let mut run = agy()
        .run(request(
            "Use invoke_subagent to launch one subagent that lists the files in this folder and reports their names. \
             Wait for it, then reply with one line.",
            &dir,
            AccessMode::FullAccess,
        ))
        .unwrap();
    let (_, status, _, events) = turn(&mut run).await;
    assert_eq!(status, DoneStatus::Completed);
    let launch = events
        .iter()
        .find_map(|e| match e {
            AgentEvent::ToolCall { id, call: ToolCall::Subagent { .. } } => Some(id.clone()),
            _ => None,
        })
        .expect("a subagent launched");
    assert!(
        events.iter().any(|e| matches!(e, AgentEvent::Subagent { parent_tool_id, .. } if *parent_tool_id == launch)),
        "its calls nest under it"
    );
    let ended = events
        .iter()
        .position(|e| matches!(e, AgentEvent::ToolResult { id, .. } if *id == launch))
        .expect("the launch ends");
    let last_child = events
        .iter()
        .rposition(|e| matches!(e, AgentEvent::Subagent { .. }))
        .unwrap();
    assert!(ended > last_child, "it ends after its last call");
    run.handle.close();
}
