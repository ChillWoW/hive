use std::sync::{Arc, Mutex};
use std::time::Duration;

use outcode_harness::{HarnessError, Run, RunCommand, RunHandle};
use outcode_proto::{
    AgentEvent, ChatConfig, ChatsUpdate, DoneStatus, MessagePart, MessageStatus, MessagesUpdate, RunRequest,
};
use outcode_store::Store;
use tokio::sync::mpsc;

use super::*;

/// What the scripted runs were asked to start with.
type Requests = Arc<Mutex<Vec<RunRequest>>>;

/// A run that answers each prompt with "echo: <prompt>" under session `s<n>`
/// (n counting runs), until closed.
fn scripted(requests: Requests) -> impl Fn(RunRequest) -> std::result::Result<Run, HarnessError> {
    move |request: RunRequest| {
        let n = {
            let mut requests = requests.lock().unwrap();
            requests.push(request.clone());
            requests.len()
        };
        let (handle, mut commands) = RunHandle::new();
        let (tx, events) = mpsc::channel(64);
        tokio::spawn(async move {
            let reply = |prompt: String| {
                vec![
                    AgentEvent::SessionStarted {
                        session_id: format!("s{n}"),
                    },
                    AgentEvent::TextDelta {
                        text: format!("echo: {prompt}"),
                    },
                    AgentEvent::Done {
                        status: DoneStatus::Completed,
                    },
                ]
            };
            for event in reply(request.prompt) {
                let _ = tx.send(event).await;
            }
            while let Some(command) = commands.recv().await {
                match command {
                    RunCommand::Send { prompt } => {
                        for event in reply(prompt) {
                            let _ = tx.send(event).await;
                        }
                    }
                    RunCommand::Interrupt => {}
                    RunCommand::Close => break,
                }
            }
        });
        Ok(Run { events, handle })
    }
}

fn engine(idle: Duration) -> (tempfile::TempDir, Engine, Requests) {
    engine_titled(idle, None)
}

/// With titles on when `title` is the text runs' answer.
fn engine_titled(idle: Duration, title: Option<&'static str>) -> (tempfile::TempDir, Engine, Requests) {
    let dir = tempfile::tempdir().unwrap();
    let requests = Requests::default();
    let hooks = Hooks {
        spawn: Box::new(scripted(requests.clone())),
        text: Box::new(move |_| title.map(|answer| Ok(answering(answer)))),
        idle: Box::new(move || idle),
    };
    let engine = Engine::new(Store::open(dir.path()).unwrap(), hooks);
    (dir, engine, requests)
}

/// A text run that answers `text` and exits once closed.
fn answering(text: &'static str) -> Run {
    let (handle, mut commands) = RunHandle::new();
    let (tx, events) = mpsc::channel(8);
    tokio::spawn(async move {
        let _ = tx.send(AgentEvent::TextDelta { text: text.into() }).await;
        let _ = tx.send(AgentEvent::Done { status: DoneStatus::Completed }).await;
        while let Some(command) = commands.recv().await {
            if command == RunCommand::Close {
                break;
            }
        }
    });
    Run { events, handle }
}

/// Collects a watcher's updates.
fn collect<T: Send + 'static>() -> (Arc<Mutex<Vec<T>>>, impl Fn(T) -> bool + Send + 'static) {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let sink = {
        let seen = seen.clone();
        move |update| {
            seen.lock().unwrap().push(update);
            true
        }
    };
    (seen, sink)
}

/// Waits for the chat's turn to end.
async fn settle(engine: &Engine, chat_id: &str) {
    for _ in 0..200 {
        let working = engine
            .state()
            .runs
            .get(chat_id)
            .is_some_and(|live| live.turn.is_some());
        if !working {
            return;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    panic!("the turn never ended");
}

fn reply_text(engine: &Engine, chat_id: &str) -> String {
    let messages = engine.store().messages(chat_id).unwrap();
    let last = messages.last().unwrap();
    assert_eq!(last.status, Some(MessageStatus::Complete));
    match &last.parts[0] {
        MessagePart::Text { text, .. } => text.clone(),
        other => panic!("{other:?}"),
    }
}

#[tokio::test]
async fn turns_stream_to_watchers_and_share_one_run() {
    let (_dir, engine, requests) = engine(Duration::from_secs(60));
    let (chats, sink) = collect();
    engine.watch_chats(sink).unwrap();
    let chat = engine.create_chat("/a".into(), ChatConfig::default()).unwrap();
    let (updates, sink) = collect();
    engine.watch_messages(&chat.id, sink).unwrap();

    engine.send(&chat.id, "one".into()).unwrap();
    // One turn at a time (the test runtime is single-threaded: nothing ran yet).
    assert!(matches!(engine.send(&chat.id, "early".into()), Err(EngineError::Busy)));
    settle(&engine, &chat.id).await;
    engine.send(&chat.id, "two".into()).unwrap();
    settle(&engine, &chat.id).await;

    assert_eq!(requests.lock().unwrap().len(), 1, "one run serves every turn");
    assert_eq!(reply_text(&engine, &chat.id), "echo: two");
    let chat = engine.store().chat(&chat.id).unwrap().unwrap();
    assert_eq!(chat.session_id.as_deref(), Some("s1"));

    let updates = updates.lock().unwrap();
    assert!(matches!(&updates[0], MessagesUpdate::Snapshot { messages } if messages.is_empty()));
    assert!(updates.iter().any(|u| matches!(
        u,
        MessagesUpdate::Event { event: AgentEvent::TextDelta { text }, .. } if text == "echo: one"
    )));
    let chats = chats.lock().unwrap();
    assert!(chats.contains(&ChatsUpdate::Working {
        chat_id: chat.id.clone(),
        working: true
    }));
    assert!(chats.contains(&ChatsUpdate::Working {
        chat_id: chat.id.clone(),
        working: false
    }));
}

#[tokio::test]
async fn an_idle_run_closes_and_the_next_prompt_resumes_it() {
    let (_dir, engine, requests) = engine(Duration::from_millis(30));
    let chat = engine.create_chat("/a".into(), ChatConfig::default()).unwrap();
    engine.send(&chat.id, "one".into()).unwrap();
    settle(&engine, &chat.id).await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(!engine.any_live(), "closed once idle");

    engine.send(&chat.id, "two".into()).unwrap();
    settle(&engine, &chat.id).await;
    let requests = requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[1].resume.as_deref(), Some("s1"));
    assert_eq!(requests[1].cwd, "/a");
    assert_eq!(reply_text(&engine, &chat.id), "echo: two");
}

#[tokio::test]
async fn a_run_that_cant_start_ends_the_turn_with_its_error() {
    let dir = tempfile::tempdir().unwrap();
    let hooks = Hooks {
        spawn: Box::new(|_| Err(HarnessError::NotInstalled("claude"))),
        text: Box::new(|_| None),
        idle: Box::new(|| Duration::from_secs(60)),
    };
    let engine = Engine::new(Store::open(dir.path()).unwrap(), hooks);
    let chat = engine.create_chat("/a".into(), ChatConfig::default()).unwrap();
    engine.send(&chat.id, "hi".into()).unwrap();
    let messages = engine.store().messages(&chat.id).unwrap();
    assert_eq!(messages.len(), 2);
    assert_eq!(messages[1].status, Some(MessageStatus::Complete));
    assert!(matches!(&messages[1].parts[0], MessagePart::Error { message, .. } if message.contains("claude")));
    assert!(!engine.any_live());
}

#[tokio::test]
async fn chats_rename_pin_archive_and_delete() {
    let (_dir, engine, _) = engine(Duration::from_secs(60));
    let chat = engine.create_chat("/a".into(), ChatConfig::default()).unwrap();
    assert_eq!(
        engine.rename(&chat.id, Some("  Mine ".into())).unwrap().title.as_deref(),
        Some("Mine")
    );
    assert_eq!(engine.rename(&chat.id, Some(" ".into())).unwrap().title, None);
    assert!(engine.set_pinned(&chat.id, true).unwrap().pinned_at.is_some());
    let archived = engine.set_archived(&chat.id, true).unwrap();
    assert!(archived.archived && archived.pinned_at.is_none());

    engine.send(&chat.id, "hi".into()).unwrap();
    let (chats, sink) = collect();
    engine.watch_chats(sink).unwrap();
    engine.delete_chat(&chat.id).unwrap();
    assert!(engine.chats().unwrap().is_empty());
    assert!(!engine.any_live());
    assert_eq!(
        chats.lock().unwrap().last(),
        Some(&ChatsUpdate::Removed { id: chat.id })
    );
}

/// Waits for the chat to get a title.
async fn titled(engine: &Engine, chat_id: &str) -> Option<String> {
    for _ in 0..200 {
        let chat = engine.store().chat(chat_id).unwrap().unwrap();
        if chat.title.is_some() {
            return chat.title;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    None
}

#[tokio::test]
async fn the_first_prompt_names_the_chat() {
    let (_dir, engine, _) = engine_titled(Duration::from_secs(60), Some("\"Echo The Prompt\"\n"));
    let (chats, sink) = collect();
    engine.watch_chats(sink).unwrap();
    let chat = engine.create_chat("/a".into(), ChatConfig::default()).unwrap();
    engine.send(&chat.id, "say it back".into()).unwrap();
    assert_eq!(titled(&engine, &chat.id).await.as_deref(), Some("Echo The Prompt"));
    assert!(chats.lock().unwrap().iter().any(|u| matches!(
        u,
        ChatsUpdate::Upsert { chat } if chat.title.as_deref() == Some("Echo The Prompt")
    )));

    // Renamed, it keeps the user's title.
    settle(&engine, &chat.id).await;
    engine.rename(&chat.id, Some("Mine".into())).unwrap();
    engine.send(&chat.id, "again".into()).unwrap();
    settle(&engine, &chat.id).await;
    tokio::time::sleep(Duration::from_millis(30)).await;
    assert_eq!(titled(&engine, &chat.id).await.as_deref(), Some("Mine"));
}

#[tokio::test]
async fn without_titles_the_prompts_first_words_stand_in() {
    let (_dir, engine, _) = engine(Duration::from_secs(60));
    let chat = engine.create_chat("/a".into(), ChatConfig::default()).unwrap();
    engine
        .send(&chat.id, "please fix the login flow on the settings page".into())
        .unwrap();
    assert_eq!(
        titled(&engine, &chat.id).await.as_deref(),
        Some("please fix the login flow on the")
    );
}

fn haiku() -> ChatConfig {
    ChatConfig {
        model: Some("claude-haiku-5-5".into()),
        ..ChatConfig::default()
    }
}

#[tokio::test]
async fn a_new_config_restarts_the_run_and_resumes_the_session() {
    let (_dir, engine, requests) = engine(Duration::from_secs(60));
    let chat = engine.create_chat("/a".into(), ChatConfig::default()).unwrap();
    engine.send(&chat.id, "one".into()).unwrap();
    settle(&engine, &chat.id).await;
    assert!(engine.any_live());

    assert_eq!(engine.set_config(&chat.id, haiku()).unwrap().config, haiku());
    assert!(!engine.any_live(), "an idle run closes at once");
    engine.send(&chat.id, "two".into()).unwrap();
    settle(&engine, &chat.id).await;

    let requests = requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[1].config, haiku());
    assert_eq!(requests[1].resume.as_deref(), Some("s1"));
}

#[tokio::test]
async fn a_config_changed_mid_turn_applies_from_the_next_prompt() {
    let (_dir, engine, requests) = engine(Duration::from_secs(60));
    let chat = engine.create_chat("/a".into(), ChatConfig::default()).unwrap();
    engine.send(&chat.id, "one".into()).unwrap();
    engine.set_config(&chat.id, haiku()).unwrap();
    assert!(engine.any_live(), "the running turn goes on");
    settle(&engine, &chat.id).await;
    assert_eq!(reply_text(&engine, &chat.id), "echo: one");
    assert!(!engine.any_live(), "closed once it ended");

    engine.send(&chat.id, "two".into()).unwrap();
    settle(&engine, &chat.id).await;
    assert_eq!(requests.lock().unwrap()[1].config, haiku());
}
