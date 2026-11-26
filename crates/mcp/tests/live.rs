//! Claude calling Outcode's MCP tools through the bridge:
//! `cargo test -p outcode-mcp -- --ignored`.

use std::time::Duration;

use outcode_harness::claude;
use outcode_mcp::{Host, Tools};
use outcode_proto::{AccessMode, AgentEvent, ChatConfig, RunRequest, ToolCall};
use serde_json::json;

fn host(dir: &std::path::Path) -> outcode_proto::McpServer {
    let tools = Tools::new()
        .tool(
            "echo",
            "Echoes the text back, with the calling chat.",
            json!({ "type": "object", "properties": { "text": { "type": "string" } }, "required": ["text"] }),
            |ctx, args| async move { Ok(json!({ "text": args["text"], "chat": ctx.chat_id })) },
        )
        .tool(
            "slow",
            "Waits 70 seconds, then answers done-waiting.",
            json!({ "type": "object", "properties": {} }),
            |_, _| async move {
                tokio::time::sleep(Duration::from_secs(70)).await;
                Ok(json!("done-waiting"))
            },
        );
    let host = Host::start(tools, dir, &tokio::runtime::Handle::current()).unwrap();
    host.server(env!("CARGO_BIN_EXE_outcode-mcp"), Vec::new()).for_chat("chat-7")
}

async fn turn(prompt: &str, mcp: outcode_proto::McpServer) -> Vec<AgentEvent> {
    let request = RunRequest {
        prompt: prompt.into(),
        config: ChatConfig {
            model: Some("claude-haiku-5-5".into()),
            access: AccessMode::Supervised,
            ..Default::default()
        },
        mcp: Some(mcp),
        ..Default::default()
    };
    let mut run = claude::run(request, None).expect("claude starts");
    let mut events = Vec::new();
    while let Some(event) = run.events.recv().await {
        if let AgentEvent::InputRequested { request, .. } = &event {
            panic!("an Outcode tool was asked about: {request:?}");
        }
        let done = matches!(event, AgentEvent::Done { .. });
        events.push(event);
        if done {
            break;
        }
    }
    events
}

fn outputs(events: &[AgentEvent], tool: &str) -> String {
    let ids: Vec<&String> = events
        .iter()
        .filter_map(|e| match e {
            AgentEvent::ToolCall { id, call: ToolCall::Mcp { server, tool: t, .. } } if server == "outcode" && t == tool => Some(id),
            _ => None,
        })
        .collect();
    assert!(!ids.is_empty(), "never called {tool}: {events:?}");
    events
        .iter()
        .filter_map(|e| match e {
            AgentEvent::ToolResult { id, output, .. } if ids.contains(&id) => output.clone(),
            _ => None,
        })
        .collect()
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "runs the real Claude CLI"]
async fn claude_calls_outcode_tools_without_asking() {
    let dir = tempfile::tempdir().unwrap();
    let events = turn(
        "Call the mcp__outcode__echo tool with text kiwi-9, then reply with just its result.",
        host(dir.path()),
    )
    .await;
    let output = outputs(&events, "echo");
    assert!(output.contains("kiwi-9") && output.contains("chat-7"), "{output}");
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "runs the real Claude CLI (and waits over a minute)"]
async fn a_tool_may_wait_past_the_clis_default_timeout() {
    let dir = tempfile::tempdir().unwrap();
    let events = turn("Call the mcp__outcode__slow tool once, then reply with its result.", host(dir.path())).await;
    let output = outputs(&events, "slow");
    assert!(output.contains("done-waiting"), "{output}");
}
