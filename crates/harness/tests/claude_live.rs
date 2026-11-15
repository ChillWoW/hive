//! Against the installed `claude`: `cargo test -p outcode-harness -- --ignored`.

use outcode_harness::{Run, claude};
use outcode_proto::{AgentEvent, DoneStatus, RunRequest};

fn start(prompt: &str) -> Run {
    let request = RunRequest {
        cwd: String::new(),
        prompt: prompt.into(),
    };
    claude::run(request, None).expect("claude starts")
}

/// One turn's text and how it ended, failing on errors.
async fn turn(run: &mut Run) -> (String, DoneStatus) {
    let mut text = String::new();
    while let Some(event) = run.events.recv().await {
        match event {
            AgentEvent::TextDelta { text: delta } => text.push_str(&delta),
            AgentEvent::Error { message } => panic!("error: {message}"),
            AgentEvent::Done { status } => return (text, status),
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
        }
    }
    run.handle.interrupt();
    assert_eq!(turn(&mut run).await.1, DoneStatus::Interrupted);

    assert!(run.handle.send("Reply with exactly the word pong and nothing else."));
    let (text, status) = turn(&mut run).await;
    assert_eq!(status, DoneStatus::Completed);
    assert!(text.to_lowercase().contains("pong"), "{text:?}");
}
