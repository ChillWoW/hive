use std::sync::{Arc, Mutex};
use std::time::Duration;

use outcode_harness::{HarnessError, Run, RunCommand, RunHandle};
use outcode_proto::{
    AgentEvent, ChatConfig, ChatsUpdate, DoneStatus, InputResponse, MessagePart, MessageStatus, MessagesUpdate, RunRequest,
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
                    RunCommand::Send { prompt, .. } => {
                        for event in reply(prompt) {
                            let _ = tx.send(event).await;
                        }
                    }
                    RunCommand::Close => break,
                    _ => {}
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
        text: Box::new(move |_, _| title.map(|answer| Ok(answering(answer)))),
        idle: Box::new(move || idle),
        worktrees: Box::new(WorktreeOptions::default),
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

/// The text of message `index`, a finished reply.
fn reply_at(engine: &Engine, chat_id: &str, index: usize) -> String {
    let messages = engine.store().messages(chat_id).unwrap();
    assert_eq!(messages[index].status, Some(MessageStatus::Complete));
    match &messages[index].parts[..] {
        [.., MessagePart::Text { text, .. }] => text.clone(),
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

    engine.send(&chat.id, "one".into(), Vec::new()).unwrap();
    // One turn at a time (the test runtime is single-threaded: nothing ran
    // yet): this one waits in the queue, and goes once "one" ends.
    engine.send(&chat.id, "early".into(), Vec::new()).unwrap();
    assert_eq!(queued(&engine, &chat.id), ["early"]);
    settle(&engine, &chat.id).await;
    assert!(queued(&engine, &chat.id).is_empty());
    assert_eq!(reply_text(&engine, &chat.id), "echo: early");
    engine.send(&chat.id, "two".into(), Vec::new()).unwrap();
    settle(&engine, &chat.id).await;

    assert_eq!(requests.lock().unwrap().len(), 1, "one run serves every turn");
    assert_eq!(reply_text(&engine, &chat.id), "echo: two");
    assert_eq!(engine.store().messages(&chat.id).unwrap().len(), 6);
    let chat = engine.store().chat(&chat.id).unwrap().unwrap();
    assert_eq!(chat.session_id.as_deref(), Some("s1"));

    let updates = updates.lock().unwrap();
    assert!(matches!(&updates[0], MessagesUpdate::Snapshot { messages } if messages.is_empty()));
    assert!(updates.iter().any(|u| matches!(
        u,
        MessagesUpdate::Event { event: AgentEvent::TextDelta { text }, .. } if text == "echo: one"
    )));
    let chats = chats.lock().unwrap();
    let working = |w: bool| {
        chats
            .iter()
            .any(|u| matches!(u, ChatsUpdate::Session { session } if session.chat_id == chat.id && session.working == w))
    };
    assert!(working(true) && working(false));
}

/// The chat's queued prompts.
fn queued(engine: &Engine, chat_id: &str) -> Vec<String> {
    engine
        .state()
        .sessions
        .get(chat_id)
        .map(|s| s.queued.iter().map(|q| q.prompt.clone()).collect())
        .unwrap_or_default()
}

/// A run whose turns wait to be ended: each prompt answers once the test
/// sends on `release` (or the run is interrupted).
fn held_run(
    commands_seen: Arc<Mutex<Vec<String>>>,
) -> impl Fn(RunRequest) -> std::result::Result<Run, HarnessError> {
    move |request: RunRequest| {
        let (handle, mut commands) = RunHandle::new();
        let (tx, events) = mpsc::channel(64);
        let seen = commands_seen.clone();
        tokio::spawn(async move {
            let mut prompt = Some(request.prompt);
            while let Some(command) = commands.recv().await {
                seen.lock().unwrap().push(format!("{command:?}"));
                match command {
                    RunCommand::Send { prompt: p, .. } => prompt = Some(p),
                    RunCommand::Interrupt => {
                        prompt = None;
                        let _ = tx.send(AgentEvent::Done { status: DoneStatus::Interrupted }).await;
                    }
                    RunCommand::Answer { request_id, response } => {
                        let _ = tx.send(AgentEvent::InputResolved { request_id, response: Some(response) }).await;
                        let text = format!("echo: {}", prompt.take().unwrap_or_default());
                        let _ = tx.send(AgentEvent::TextDelta { text }).await;
                        let _ = tx.send(AgentEvent::Done { status: DoneStatus::Completed }).await;
                    }
                    RunCommand::Close => break,
                    _ => {}
                }
            }
        });
        Ok(Run { events, handle })
    }
}

fn held_engine() -> (tempfile::TempDir, Engine, Arc<Mutex<Vec<String>>>) {
    let dir = tempfile::tempdir().unwrap();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let hooks = Hooks {
        spawn: Box::new(held_run(seen.clone())),
        text: Box::new(|_, _| None),
        idle: Box::new(|| Duration::from_secs(60)),
        worktrees: Box::new(WorktreeOptions::default),
    };
    let engine = Engine::new(Store::open(dir.path()).unwrap(), hooks);
    (dir, engine, seen)
}

fn approve() -> InputResponse {
    InputResponse::Approval {
        decision: outcode_proto::ApprovalDecision::Allow,
    }
}

#[tokio::test]
async fn a_stop_holds_the_queue_until_the_users_next_turn_ends() {
    let (_dir, engine, _) = held_engine();
    let chat = engine.create_chat("/a".into(), ChatConfig::default()).unwrap();
    engine.send(&chat.id, "one".into(), Vec::new()).unwrap();
    engine.send(&chat.id, "later".into(), Vec::new()).unwrap();
    engine.interrupt(&chat.id);
    settle(&engine, &chat.id).await;
    assert_eq!(queued(&engine, &chat.id), ["later"], "held after the stop");
    assert!(engine.state().sessions[&chat.id].held);

    engine.send(&chat.id, "two".into(), Vec::new()).unwrap();
    engine.answer(&chat.id, "r", approve()).unwrap();
    // "two" ends: the hold lifts and "later" goes.
    until(|| queued(&engine, &chat.id).is_empty()).await;
    assert!(engine.state().working(&chat.id));
    assert_eq!(reply_at(&engine, &chat.id, 3), "echo: two");
    engine.answer(&chat.id, "r", approve()).unwrap();
    settle(&engine, &chat.id).await;
    assert_eq!(reply_at(&engine, &chat.id, 5), "echo: later");
}

#[tokio::test]
async fn send_now_stops_the_turn_and_jumps_the_queue() {
    let (_dir, engine, _) = held_engine();
    let chat = engine.create_chat("/a".into(), ChatConfig::default()).unwrap();
    engine.send(&chat.id, "one".into(), Vec::new()).unwrap();
    engine.send(&chat.id, "a".into(), Vec::new()).unwrap();
    engine.send(&chat.id, "b".into(), Vec::new()).unwrap();
    engine.send(&chat.id, "c".into(), Vec::new()).unwrap();
    let id = engine.state().sessions[&chat.id].queued[1].id.clone();
    engine.send_queued_now(&chat.id, &id).unwrap();
    // "one" is stopped and "b" runs now, ahead of "a".
    until(|| queued(&engine, &chat.id) == ["a", "c"]).await;
    let messages = engine.store().messages(&chat.id).unwrap();
    assert!(matches!(&messages[2].parts[0], MessagePart::Text { text, .. } if text == "b"));

    let last = engine.state().sessions[&chat.id].queued[1].id.clone();
    engine.cancel_queued(&chat.id, &last);
    assert_eq!(queued(&engine, &chat.id), ["a"]);
}

/// A run whose first turn calls tools `t1` and `t2` and waits; each answer
/// finishes the next of them, an interrupt ends the turn, and later prompts
/// echo.
fn tool_run(request: RunRequest) -> std::result::Result<Run, HarnessError> {
    let (handle, mut commands) = RunHandle::new();
    let (tx, events) = mpsc::channel(64);
    tokio::spawn(async move {
        drop(request);
        for id in ["t1", "t2"] {
            let call = outcode_proto::ToolCall::Exec { command: "ls".into() };
            let _ = tx.send(AgentEvent::ToolCall { id: id.into(), call }).await;
        }
        let mut pending = vec!["t1", "t2"].into_iter();
        while let Some(command) = commands.recv().await {
            match command {
                RunCommand::Answer { .. } => {
                    if let Some(id) = pending.next() {
                        let _ = tx.send(AgentEvent::ToolResult { id: id.into(), is_error: false, output: None }).await;
                    }
                }
                RunCommand::Interrupt => {
                    let _ = tx.send(AgentEvent::Done { status: DoneStatus::Interrupted }).await;
                }
                RunCommand::Send { prompt, .. } => {
                    let _ = tx.send(AgentEvent::TextDelta { text: format!("echo: {prompt}") }).await;
                    let _ = tx.send(AgentEvent::Done { status: DoneStatus::Completed }).await;
                }
                RunCommand::Close => break,
                _ => {}
            }
        }
    });
    Ok(Run { events, handle })
}

#[tokio::test]
async fn after_tool_stops_the_turn_once_its_tool_calls_finish() {
    let dir = tempfile::tempdir().unwrap();
    let hooks = Hooks {
        spawn: Box::new(tool_run),
        text: Box::new(|_, _| None),
        idle: Box::new(|| Duration::from_secs(60)),
        worktrees: Box::new(WorktreeOptions::default),
    };
    let engine = Engine::new(Store::open(dir.path()).unwrap(), hooks);
    let chat = engine.create_chat("/a".into(), ChatConfig::default()).unwrap();
    engine.send(&chat.id, "one".into(), Vec::new()).unwrap();
    engine.send(&chat.id, "later".into(), Vec::new()).unwrap();
    engine
        .send_with(&chat.id, "steer".into(), Vec::new(), SendMode::AfterTool)
        .unwrap();
    until(|| {
        engine.state().runs[&chat.id]
            .turn
            .as_ref()
            .is_some_and(|t| t.assistant.parts.len() == 2)
    })
    .await;

    // "t1" finishes but "t2" still runs: the turn goes on.
    engine.answer(&chat.id, "r", approve()).unwrap();
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert_eq!(queued(&engine, &chat.id), ["later", "steer"]);
    assert!(engine.state().working(&chat.id));

    // "t2" finishes: the turn stops and "steer" goes, ahead of "later".
    engine.answer(&chat.id, "r", approve()).unwrap();
    until(|| queued(&engine, &chat.id).is_empty()).await;
    settle(&engine, &chat.id).await;
    let messages = engine.store().messages(&chat.id).unwrap();
    assert!(matches!(&messages[2].parts[0], MessagePart::Text { text, .. } if text == "steer"));
    assert_eq!(reply_at(&engine, &chat.id, 3), "echo: steer");
    assert_eq!(reply_at(&engine, &chat.id, 5), "echo: later");
}

/// Waits until `done` holds.
async fn until(done: impl Fn() -> bool) {
    for _ in 0..200 {
        if done() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    panic!("never happened");
}

#[tokio::test]
async fn approving_a_plan_leaves_plan_mode_and_modes_switch_in_place() {
    let (_dir, engine, seen) = held_engine();
    let config = ChatConfig {
        plan: true,
        ..ChatConfig::default()
    };
    let chat = engine.create_chat("/a".into(), config.clone()).unwrap();
    engine.send(&chat.id, "plan it".into(), Vec::new()).unwrap();
    let supervised = ChatConfig {
        access: outcode_proto::AccessMode::Supervised,
        ..config
    };
    engine.set_config(&chat.id, supervised).unwrap();
    assert!(engine.any_live(), "a mode change keeps the run");
    engine
        .answer(
            &chat.id,
            "plan",
            InputResponse::Plan {
                approve: true,
                feedback: None,
            },
        )
        .unwrap();
    settle(&engine, &chat.id).await;
    let chat = engine.store().chat(&chat.id).unwrap().unwrap();
    assert!(!chat.config.plan);
    let seen = seen.lock().unwrap();
    assert!(seen.iter().any(|c| c.starts_with("SetModes { access: Supervised, plan: true }")));
}

#[tokio::test]
async fn an_idle_run_closes_and_the_next_prompt_resumes_it() {
    let (_dir, engine, requests) = engine(Duration::from_millis(30));
    let chat = engine.create_chat("/a".into(), ChatConfig::default()).unwrap();
    engine.send(&chat.id, "one".into(), Vec::new()).unwrap();
    settle(&engine, &chat.id).await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(!engine.any_live(), "closed once idle");

    engine.send(&chat.id, "two".into(), Vec::new()).unwrap();
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
        text: Box::new(|_, _| None),
        idle: Box::new(|| Duration::from_secs(60)),
        worktrees: Box::new(WorktreeOptions::default),
    };
    let engine = Engine::new(Store::open(dir.path()).unwrap(), hooks);
    let chat = engine.create_chat("/a".into(), ChatConfig::default()).unwrap();
    engine.send(&chat.id, "hi".into(), Vec::new()).unwrap();
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

    engine.send(&chat.id, "hi".into(), Vec::new()).unwrap();
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
    engine.send(&chat.id, "say it back".into(), Vec::new()).unwrap();
    assert_eq!(titled(&engine, &chat.id).await.as_deref(), Some("Echo The Prompt"));
    assert!(chats.lock().unwrap().iter().any(|u| matches!(
        u,
        ChatsUpdate::Upsert { chat } if chat.title.as_deref() == Some("Echo The Prompt")
    )));

    // Renamed, it keeps the user's title.
    settle(&engine, &chat.id).await;
    engine.rename(&chat.id, Some("Mine".into())).unwrap();
    engine.send(&chat.id, "again".into(), Vec::new()).unwrap();
    settle(&engine, &chat.id).await;
    tokio::time::sleep(Duration::from_millis(30)).await;
    assert_eq!(titled(&engine, &chat.id).await.as_deref(), Some("Mine"));
}

#[tokio::test]
async fn without_titles_the_prompts_first_words_stand_in() {
    let (_dir, engine, _) = engine(Duration::from_secs(60));
    let chat = engine.create_chat("/a".into(), ChatConfig::default()).unwrap();
    engine
        .send(&chat.id, "please fix the login flow on the settings page".into(), Vec::new())
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
    engine.send(&chat.id, "one".into(), Vec::new()).unwrap();
    settle(&engine, &chat.id).await;
    assert!(engine.any_live());

    assert_eq!(engine.set_config(&chat.id, haiku()).unwrap().config, haiku());
    assert!(!engine.any_live(), "an idle run closes at once");
    engine.send(&chat.id, "two".into(), Vec::new()).unwrap();
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
    engine.send(&chat.id, "one".into(), Vec::new()).unwrap();
    engine.set_config(&chat.id, haiku()).unwrap();
    assert!(engine.any_live(), "the running turn goes on");
    settle(&engine, &chat.id).await;
    assert_eq!(reply_text(&engine, &chat.id), "echo: one");
    assert!(!engine.any_live(), "closed once it ended");

    engine.send(&chat.id, "two".into(), Vec::new()).unwrap();
    settle(&engine, &chat.id).await;
    assert_eq!(requests.lock().unwrap()[1].config, haiku());
}

#[tokio::test]
async fn a_background_subagent_reports_into_the_reply_that_spawned_it() {
    let dir = tempfile::tempdir().unwrap();
    let hooks = Hooks {
        spawn: Box::new(|_request: RunRequest| {
            let (handle, mut commands) = RunHandle::new();
            let (tx, events) = mpsc::channel(64);
            tokio::spawn(async move {
                let spawn = AgentEvent::ToolCall {
                    id: "s1".into(),
                    call: outcode_proto::ToolCall::Subagent {
                        description: "scan".into(),
                        model: None,
                        prompt: None,
                        agent: None,
                    },
                };
                let inner = |event| AgentEvent::Subagent {
                    parent_tool_id: "s1".into(),
                    event: Box::new(event),
                };
                for event in [
                    spawn,
                    AgentEvent::ToolResult { id: "s1".into(), is_error: false, output: Some("Async agent launched".into()) },
                    AgentEvent::Done { status: DoneStatus::Completed },
                ] {
                    let _ = tx.send(event).await;
                }
                while let Some(command) = commands.recv().await {
                    match command {
                        RunCommand::Send { .. } => {
                            for event in [
                                AgentEvent::TextDelta { text: "second".into() },
                                inner(AgentEvent::TextDelta { text: "found it".into() }),
                                inner(AgentEvent::Done { status: DoneStatus::Completed }),
                                AgentEvent::Done { status: DoneStatus::Completed },
                            ] {
                                let _ = tx.send(event).await;
                            }
                        }
                        RunCommand::Close => break,
                        _ => {}
                    }
                }
            });
            Ok(Run { events, handle })
        }),
        text: Box::new(|_, _| None),
        idle: Box::new(|| Duration::from_secs(60)),
        worktrees: Box::new(WorktreeOptions::default),
    };
    let engine = Engine::new(Store::open(dir.path()).unwrap(), hooks);
    let chat = engine.create_chat("/a".into(), ChatConfig::default()).unwrap();
    engine.send(&chat.id, "one".into(), Vec::new()).unwrap();
    settle(&engine, &chat.id).await;
    engine.send(&chat.id, "two".into(), Vec::new()).unwrap();
    settle(&engine, &chat.id).await;

    let messages = engine.store().messages(&chat.id).unwrap();
    assert!(matches!(
        &messages[1].parts[0],
        MessagePart::Tool { subagent: Some(outcode_proto::SubagentStatus::Done), thread, .. } if thread.len() == 1
    ), "{:?}", messages[1].parts);
    assert!(matches!(&messages[3].parts[..], [MessagePart::Text { text, .. }] if text == "second"));
}

/// Runs git in `cwd`; false when it failed (or isn't installed).
fn git(cwd: &std::path::Path, args: &[&str]) -> bool {
    std::process::Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .is_ok_and(|o| o.status.success())
}

#[tokio::test]
async fn a_worktree_chat_runs_in_its_worktree_and_takes_it_when_deleted() {
    let project = tempfile::tempdir().unwrap();
    let path = project.path();
    let ready = [
        &["init", "-q", "-b", "main"][..],
        &["config", "user.email", "test@example.com"],
        &["config", "user.name", "Test"],
        &["config", "commit.gpgsign", "false"],
        &["commit", "-q", "--allow-empty", "-m", "first"],
    ]
    .iter()
    .all(|args| git(path, args));
    if !ready {
        return;
    }
    let worktrees = tempfile::tempdir().unwrap();
    let dir = tempfile::tempdir().unwrap();
    let requests = Requests::default();
    let options = WorktreeOptions {
        dir: worktrees.path().to_path_buf(),
        semantic: true,
        prefix: String::new(),
        delete_branch: true,
    };
    let hooks = Hooks {
        spawn: Box::new(scripted(requests.clone())),
        // Only the branch run answers; titles are off.
        text: Box::new(|kind, _| (kind == TextUse::Branch).then(|| Ok(answering("fix/login-redirect")))),
        idle: Box::new(|| Duration::from_secs(60)),
        worktrees: Box::new(move || options.clone()),
    };
    let engine = Engine::new(Store::open(dir.path()).unwrap(), hooks);

    let steps = Mutex::new(Vec::new());
    let new = NewWorktree {
        base: None,
        hint: Some("Fix the login redirect".into()),
    };
    let cwd = path.to_string_lossy().into_owned();
    let chat = engine
        .create_chat_in_worktree(cwd, ChatConfig::default(), new, |s| steps.lock().unwrap().push(s))
        .await
        .unwrap();
    assert_eq!(
        *steps.lock().unwrap(),
        [
            WorktreeStep::Naming,
            WorktreeStep::CheckingOut {
                branch: "fix/login-redirect".into()
            }
        ]
    );
    let worktree = chat.worktree.clone().unwrap();
    assert_eq!(worktree.branch, "fix/login-redirect");
    assert_eq!(worktree.base, "main");

    // The agent runs there, and gets it back when it's gone.
    std::fs::remove_dir_all(&worktree.root).unwrap();
    engine.send(&chat.id, "go".into(), Vec::new()).unwrap();
    settle(&engine, &chat.id).await;
    assert_eq!(requests.lock().unwrap()[0].cwd, worktree.path);
    assert!(std::path::Path::new(&worktree.root).join(".git").exists());

    engine.delete_chat(&chat.id).unwrap();
    let refname = format!("refs/heads/{}", worktree.branch);
    for _ in 0..400 {
        if !std::path::Path::new(&worktree.root).exists() && !git(path, &["show-ref", "--verify", "--quiet", &refname]) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("the worktree or its branch outlived the chat");
}
