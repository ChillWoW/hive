//! Against the installed `claude`: `cargo test -p outcode-harness -- --ignored`.

use outcode_harness::claude;
use outcode_proto::{AgentEvent, RunRequest};

#[tokio::test]
#[ignore = "runs the real Claude CLI"]
async fn plain_prompt_streams_text_then_done() {
    let request = RunRequest {
        cwd: String::new(),
        prompt: "Reply with exactly the word pong and nothing else.".into(),
    };
    let mut run = claude::run(request, None).expect("claude starts");
    let mut text = String::new();
    let mut events = Vec::new();
    while let Some(event) = run.events.recv().await {
        if let AgentEvent::TextDelta { text: delta } = &event {
            text.push_str(delta);
        }
        events.push(event);
    }
    assert_eq!(events.last(), Some(&AgentEvent::Done), "{events:?}");
    assert!(!events.iter().any(|e| matches!(e, AgentEvent::Error { .. })), "{events:?}");
    assert!(text.to_lowercase().contains("pong"), "{text:?}");
}
