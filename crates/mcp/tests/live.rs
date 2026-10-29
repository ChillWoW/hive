//! Real agents calling Hive's MCP server: the engine stamps the server on a
//! chat's run, the CLI launches the `hive-mcp` bridge, the agent calls a
//! tool, the host runs it as that chat. In supervised mode, so a Hive tool
//! that got asked about would hang the turn. Spends a few tokens; ignored
//! by default. The `_waits_` tests hold the call past a minute, as a tool
//! waiting on the user (`request_secret`) does, where the CLIs' own
//! timeouts would cut it off:
//!
//!     cargo test -p hive-mcp --test live -- --ignored --test-threads 1

use std::sync::{Arc, Mutex};
use std::time::Duration;

use hive_engine::{Engine, EngineConfig};
use hive_harness::{ClaudeHarness, CodexHarness, Harness, OpencodeHarness};
use hive_mcp::{Ctx, Host, Tools};
use hive_proto::{
    AccessMode, AgentEvent, ChatConfig, CommandPayload, DoneStatus, MessagesUpdate, ReasoningLevel,
    SandboxLevel,
};
use hive_store::Store;
use serde_json::{json, Value};
use tokio::sync::mpsc;

const WAIT: Duration = Duration::from_secs(240);
const WORD: &str = "pineapple-42";

/// `delay`: how long the tool takes to answer.
async fn agent_calls_hive(
    harness: Arc<dyn Harness>,
    model: Option<&str>,
    reasoning: Option<ReasoningLevel>,
    delay: Duration,
) {
    let data = tempfile::tempdir().unwrap();
    let work = tempfile::tempdir().unwrap();
    let calls: Arc<Mutex<Vec<(Ctx, Value)>>> = Arc::default();
    let seen = Arc::clone(&calls);
    let tools = Tools::new().tool(
        "echo",
        "Echoes `text` back, signed by Hive.",
        json!({"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]}),
        move |ctx, args| {
            seen.lock().unwrap().push((ctx, args.clone()));
            async move {
                tokio::time::sleep(delay).await;
                Ok(json!(format!(
                    "Hive says: {}",
                    args["text"].as_str().unwrap_or_default()
                )))
            }
        },
    );
    let host = Host::start(tools, data.path(), &tokio::runtime::Handle::current()).unwrap();
    let id = harness.id();
    let engine = Engine::new(
        Store::open(data.path()).unwrap(),
        vec![harness],
        EngineConfig {
            mcp: Some(host.server(env!("CARGO_BIN_EXE_hive-mcp"), vec![])),
            ..EngineConfig::default()
        },
        tokio::runtime::Handle::current(),
    );
    engine.start().unwrap();
    let chat = engine
        .create_chat(
            work.path().to_string_lossy(),
            ChatConfig {
                harness: id,
                model: model.map(Into::into),
                reasoning,
                model_options: Default::default(),
                sandbox: SandboxLevel::WorkspaceWrite,
                access: AccessMode::Supervised,
                plan: false,
            },
        )
        .unwrap();
    let (tx, mut rx) = mpsc::unbounded_channel();
    engine
        .watch_messages(&chat.id, move |u| tx.send(u).is_ok())
        .unwrap();
    engine
        .queue_command(
            &chat.id,
            CommandPayload::Send {
                prompt: format!(
                    "Call the `echo` tool of the `hive` MCP server with text \"{WORD}\", \
                     then reply with exactly what it returned. Use no other tools."
                ),
                message_id: "user-1".into(),
                attachments: Vec::new(),
            },
        )
        .unwrap();

    let mut text = String::new();
    let status = tokio::time::timeout(WAIT + delay, async {
        while let Some(update) = rx.recv().await {
            if let MessagesUpdate::Event { event, .. } = update {
                match event {
                    AgentEvent::TextDelta { text: t, .. } => text.push_str(&t),
                    AgentEvent::InputRequested { questions, .. } => {
                        panic!("asked instead of calling: {questions:?}")
                    }
                    AgentEvent::Done { status, error, .. } => {
                        assert_ne!(status, DoneStatus::Errored, "{error:?}");
                        return status;
                    }
                    _ => {}
                }
            }
        }
        panic!("watch ended");
    })
    .await
    .expect("no Done in time");
    engine.shutdown(Duration::from_secs(5)).await;

    assert_eq!(status, DoneStatus::Completed);
    let calls = calls.lock().unwrap();
    assert!(
        !calls.is_empty(),
        "the tool was never called; reply: {text}"
    );
    let (ctx, args) = &calls[0];
    assert_eq!(ctx.chat_id.as_deref(), Some(chat.id.as_str()));
    assert_eq!(args["text"], WORD);
    assert!(
        text.contains(&format!("Hive says: {WORD}")),
        "reply: {text}"
    );
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "spends tokens on the real claude CLI"]
async fn claude_calls_a_hive_tool() {
    agent_calls_hive(Arc::new(ClaudeHarness::new()), Some("haiku"), None, Duration::ZERO).await;
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "spends tokens on the real codex CLI"]
async fn codex_calls_a_hive_tool() {
    // The catalog's first model: config.toml's default may be one the
    // account can't use.
    let harness = CodexHarness::new();
    let model = harness.catalog().models.first().map(|m| m.id.clone());
    agent_calls_hive(
        Arc::new(harness),
        model.as_deref(),
        Some(ReasoningLevel::Low),
        Duration::ZERO,
    )
    .await;
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "spends tokens on the real opencode CLI"]
async fn opencode_calls_a_hive_tool() {
    agent_calls_hive(Arc::new(OpencodeHarness::new()), None, None, Duration::ZERO).await;
}

/// Past every CLI's default tool-call timeout (Codex 60s, OpenCode 5s).
const SLOW: Duration = Duration::from_secs(75);

#[tokio::test(flavor = "multi_thread")]
#[ignore = "spends tokens on the real claude CLI"]
async fn claude_waits_on_a_slow_hive_tool() {
    agent_calls_hive(Arc::new(ClaudeHarness::new()), Some("haiku"), None, SLOW).await;
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "spends tokens on the real codex CLI"]
async fn codex_waits_on_a_slow_hive_tool() {
    let harness = CodexHarness::new();
    let model = harness.catalog().models.first().map(|m| m.id.clone());
    agent_calls_hive(
        Arc::new(harness),
        model.as_deref(),
        Some(ReasoningLevel::Low),
        SLOW,
    )
    .await;
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "spends tokens on the real opencode CLI"]
async fn opencode_waits_on_a_slow_hive_tool() {
    agent_calls_hive(Arc::new(OpencodeHarness::new()), None, None, SLOW).await;
}
