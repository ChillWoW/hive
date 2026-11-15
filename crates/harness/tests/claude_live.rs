//! Against the installed `claude`: `cargo test -p outcode-harness -- --ignored`.

use outcode_harness::{Run, claude};
use outcode_proto::{AgentEvent, DoneStatus, RunRequest, ToolCall};

fn start(prompt: &str) -> Run {
    start_in("", prompt)
}

fn start_in(cwd: &str, prompt: &str) -> Run {
    let request = RunRequest {
        cwd: cwd.into(),
        prompt: prompt.into(),
        resume: None,
    };
    claude::run(request, None).expect("claude starts")
}

#[tokio::test]
#[ignore = "runs the real Claude CLI"]
async fn tool_call_comes_back_normalized_with_its_result() {
    let dir = std::env::temp_dir().join(format!("outcode-live-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("note.txt"), "the secret is walrus\n").unwrap();
    let mut run = start_in(
        dir.to_str().unwrap(),
        "Use the Read tool on note.txt, then reply with just the secret word.",
    );
    let mut read = None;
    let mut resolved = false;
    let mut text = String::new();
    loop {
        match run.events.recv().await.expect("event") {
            AgentEvent::ToolCall { id, call: ToolCall::ReadFile { path } } => {
                assert!(path.ends_with("note.txt"), "{path}");
                read = Some(id);
            }
            AgentEvent::ToolResult { id, is_error, output } if Some(&id) == read.as_ref() => {
                assert!(!is_error, "{output:?}");
                assert!(output.unwrap_or_default().contains("walrus"));
                resolved = true;
            }
            AgentEvent::TextDelta { text: delta } => text.push_str(&delta),
            AgentEvent::Error { message } => panic!("error: {message}"),
            AgentEvent::Done { status } => {
                assert_eq!(status, DoneStatus::Completed);
                break;
            }
            _ => {}
        }
    }
    assert!(resolved, "the read never resolved");
    assert!(text.to_lowercase().contains("walrus"), "{text:?}");
    let _ = std::fs::remove_dir_all(&dir);
}

/// One turn's text and how it ended, failing on errors.
async fn turn(run: &mut Run) -> (String, DoneStatus) {
    let mut text = String::new();
    while let Some(event) = run.events.recv().await {
        match event {
            AgentEvent::TextDelta { text: delta } => text.push_str(&delta),
            AgentEvent::Error { message } => panic!("error: {message}"),
            AgentEvent::Done { status } => return (text, status),
            _ => {}
        }
    }
    panic!("the run ended mid-turn: {text:?}");
}

#[tokio::test]
#[ignore = "runs the real Claude CLI"]
async fn plain_prompt_streams_text_then_done() {
    let mut run = start("Reply with exactly the word pong and nothing else.");
    let (text, status) = turn(&mut run).await;
    assert_eq!(status, DoneStatus::Completed);
    assert!(text.to_lowercase().contains("pong"), "{text:?}");

    run.handle.close();
    assert_eq!(run.events.recv().await, None, "the stream ends once closed");
}

#[tokio::test]
#[ignore = "runs the real Claude CLI"]
async fn second_turn_sees_the_first() {
    let mut run = start("Remember the word zebra. Reply with just OK.");
    assert_eq!(turn(&mut run).await.1, DoneStatus::Completed);

    assert!(run.handle.send("Which word did I ask you to remember? Reply with just the word."));
    let (text, status) = turn(&mut run).await;
    assert_eq!(status, DoneStatus::Completed);
    assert!(text.to_lowercase().contains("zebra"), "{text:?}");
}

#[tokio::test]
#[ignore = "runs the real Claude CLI"]
async fn interrupt_stops_the_turn_and_keeps_the_session() {
    let mut run = start("Write the numbers from 1 to 400, each on its own line, nothing else.");
    loop {
        match run.events.recv().await.expect("event") {
            AgentEvent::TextDelta { .. } => break,
            AgentEvent::Done { status } => panic!("ended before streaming: {status:?}"),
            AgentEvent::Error { message } => panic!("error: {message}"),
            _ => {}
        }
    }
    run.handle.interrupt();
    assert_eq!(turn(&mut run).await.1, DoneStatus::Interrupted);

    assert!(run.handle.send("Reply with exactly the word pong and nothing else."));
    let (text, status) = turn(&mut run).await;
    assert_eq!(status, DoneStatus::Completed);
    assert!(text.to_lowercase().contains("pong"), "{text:?}");
}

#[tokio::test]
#[ignore = "runs the real Claude CLI"]
async fn a_new_run_resumes_the_session() {
    let mut run = start("Remember the word otter. Reply with just OK.");
    let mut session = None;
    loop {
        match run.events.recv().await.expect("event") {
            AgentEvent::SessionStarted { session_id } => session = Some(session_id),
            AgentEvent::Error { message } => panic!("error: {message}"),
            AgentEvent::Done { status } => {
                assert_eq!(status, DoneStatus::Completed);
                break;
            }
            _ => {}
        }
    }
    let session = session.expect("the run reports its session");
    run.handle.close();
    assert_eq!(run.events.recv().await, None);

    let request = RunRequest {
        cwd: String::new(),
        prompt: "Which word did I ask you to remember? Reply with just the word.".into(),
        resume: Some(session),
    };
    let mut run = claude::run(request, None).expect("claude starts");
    let (text, status) = turn(&mut run).await;
    assert_eq!(status, DoneStatus::Completed);
    assert!(text.to_lowercase().contains("otter"), "{text:?}");
}

#[tokio::test]
#[ignore = "runs the real Claude CLI"]
async fn a_text_run_answers_without_tools() {
    let prompt = "Write a title for this session. Return only a concise 3-5 word title in Title \
        Case.\n\nSession request (JSON string):\n\"Read note.txt and fix the login form validation\"";
    let mut run = claude::run_text(prompt.into(), Some("haiku"), None).expect("claude starts");
    let mut text = String::new();
    loop {
        match run.events.recv().await.expect("event") {
            AgentEvent::TextDelta { text: delta } => text.push_str(&delta),
            AgentEvent::ToolCall { call, .. } => panic!("it used a tool: {call:?}"),
            AgentEvent::Error { message } => panic!("error: {message}"),
            AgentEvent::Done { status } => {
                assert_eq!(status, DoneStatus::Completed);
                break;
            }
            _ => {}
        }
    }
    run.handle.close();
    assert_eq!(run.events.recv().await, None);
    let words = text.split_whitespace().count();
    assert!((1..=8).contains(&words), "{text:?}");
    eprintln!("title: {text}");
}
