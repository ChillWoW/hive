//! The engine driving the real `codex` CLI: a chat's turns, its title, and a
//! config change that resumes the thread in a new run. Spends a few tokens;
//! ignored by default:
//!
//!     cargo test -p hive-engine --test codex_live -- --ignored

use std::sync::Arc;
use std::time::Duration;

use hive_engine::{Engine, EngineConfig};
use hive_harness::{CodexHarness, Harness};
use hive_proto::{
    AgentEvent, ChatConfig, ChatsUpdate, CommandPayload, DoneStatus, HarnessId, MessagePart,
    MessagesUpdate, ReasoningLevel, SandboxLevel,
};
use hive_store::Store;
use tokio::sync::mpsc;
use tokio::time::timeout;

const WAIT: Duration = Duration::from_secs(180);

fn send(prompt: &str, n: usize) -> CommandPayload {
    CommandPayload::Send {
        prompt: prompt.into(),
        message_id: format!("user-{n}"),
        attachments: Vec::new(),
    }
}

async fn done(rx: &mut mpsc::UnboundedReceiver<MessagesUpdate>) -> DoneStatus {
    timeout(WAIT, async {
        while let Some(update) = rx.recv().await {
            if let MessagesUpdate::Event {
                event: AgentEvent::Done { status, error, .. },
                ..
            } = update
            {
                assert_ne!(status, DoneStatus::Errored, "{error:?}");
                return status;
            }
        }
        panic!("watch ended");
    })
    .await
    .expect("no Done in time")
}

fn last_reply(engine: &Engine, chat_id: &str) -> String {
    let messages = engine.store().messages(chat_id).unwrap();
    messages
        .last()
        .unwrap()
        .parts
        .iter()
        .filter_map(|p| match p {
            MessagePart::Text { text, .. } => Some(text.as_str()),
            _ => None,
        })
        .collect()
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "spends tokens on the real codex CLI"]
async fn a_codex_chat_runs_is_titled_and_resumes_after_a_config_change() {
    let dir = tempfile::tempdir().unwrap();
    let work = tempfile::tempdir().unwrap();
    let harness = CodexHarness::new();
    let catalog = harness.catalog();
    let harness: Arc<dyn Harness> = Arc::new(harness);
    let engine = Engine::new(
        Store::open(dir.path()).unwrap(),
        vec![harness],
        EngineConfig::default(),
        tokio::runtime::Handle::current(),
    );
    let config = ChatConfig {
        harness: HarnessId::Codex,
        model: catalog.default_model.clone(),
        reasoning: Some(ReasoningLevel::Low),
        model_options: Default::default(),
        sandbox: SandboxLevel::WorkspaceWrite,
        access: Default::default(),
        plan: false,
    };
    let chat = engine
        .create_chat(work.path().display().to_string(), config.clone())
        .unwrap();
    let (tx, mut updates) = mpsc::unbounded_channel();
    engine
        .watch_messages(&chat.id, move |u| tx.send(u).is_ok())
        .unwrap();
    let (tx, mut chats) = mpsc::unbounded_channel();
    engine.watch_chats(move |u| tx.send(u).is_ok()).unwrap();

    engine
        .queue_command(&chat.id, send("Remember the word OTTER. Reply with just OK.", 1))
        .unwrap();
    assert_eq!(done(&mut updates).await, DoneStatus::Completed);

    // Titled in the background by a Codex title run.
    let title = timeout(WAIT, async {
        while let Some(update) = chats.recv().await {
            if let ChatsUpdate::Chat { chat: c } = update {
                if c.id == chat.id {
                    if let Some(title) = c.title {
                        return title;
                    }
                }
            }
        }
        panic!("chat watch ended");
    })
    .await
    .expect("no title in time");
    assert!(!title.is_empty());
    let session = engine.chats().unwrap()[0].harness_session_id.clone();
    assert!(session.is_some());

    // A model change closes the run; the next prompt resumes the thread.
    let other = catalog
        .models
        .iter()
        .map(|m| m.id.clone())
        .find(|id| Some(id) != config.model.as_ref())
        .or(config.model.clone());
    engine
        .update_config(
            &chat.id,
            ChatConfig {
                model: other,
                ..config
            },
        )
        .unwrap();
    engine
        .queue_command(
            &chat.id,
            send("What word did I ask you to remember? Reply with just it.", 2),
        )
        .unwrap();
    assert_eq!(done(&mut updates).await, DoneStatus::Completed);
    tokio::time::sleep(Duration::from_millis(500)).await;
    let reply = last_reply(&engine, &chat.id);
    assert!(reply.to_uppercase().contains("OTTER"), "{reply}");
    assert_eq!(engine.chats().unwrap()[0].harness_session_id, session);
    println!("title: {title}");
}
