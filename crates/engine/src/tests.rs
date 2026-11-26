use std::sync::{Arc, Mutex};
use std::time::Duration;

use outcode_harness::mock::{Mock, Seen, Step, echo};
use outcode_harness::{HarnessError, RunCommand};
use outcode_proto::{
    AgentEvent, ChatConfig, ChatsUpdate, DoneStatus, HarnessId, InputResponse, MessagePart, MessageStatus, MessagesUpdate,
};
use outcode_store::Store;

use super::*;

/// An engine over `mock`, with text runs on for the uses `text_model` names.
fn engine_with(
    mock: Mock,
    idle: Duration,
    text_model: impl Fn(TextUse) -> Option<TextModel> + Send + Sync + 'static,
) -> (tempfile::TempDir, Engine, Arc<Seen>) {
    let dir = tempfile::tempdir().unwrap();
    let seen = mock.seen();
    let hooks = Hooks {
        harnesses: vec![Arc::new(mock)],
        text_model: Box::new(text_model),
        idle: Box::new(move || idle),
        worktrees: Box::new(WorktreeOptions::default),
    };
    let engine = Engine::new(Store::open(dir.path()).unwrap(), hooks);
    (dir, engine, seen)
}

/// Turns echo their prompts; text runs are off.
fn engine(idle: Duration) -> (tempfile::TempDir, Engine, Arc<Seen>) {
    engine_with(Mock::new(), idle, |_| None)
}

/// With titles on, the text runs answering `title`.
fn engine_titled(idle: Duration, title: &str) -> (tempfile::TempDir, Engine, Arc<Seen>) {
    engine_with(Mock::new().text(title), idle, |_| Some(claude_text()))
}

/// Text runs on Claude's default model.
fn claude_text() -> TextModel {
    TextModel {
        harness: HarnessId::Claude,
        model: String::new(),
    }
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
    let (_dir, engine, seen) = engine(Duration::from_secs(60));
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

    assert_eq!(seen.runs().len(), 1, "one run serves every turn");
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

/// Turns that wait to be ended: each echoes its prompt once answered (or
/// ends when interrupted).
fn held_engine() -> (tempfile::TempDir, Engine, Arc<Seen>) {
    let held = Mock::new().script(|turn| vec![Step::Wait, Step::text(format!("echo: {}", turn.prompt))]);
    engine_with(held, Duration::from_secs(60), |_| None)
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

/// The first turn calls tools `t1` and `t2` and waits; each answer finishes
/// the next of them, and then it waits to be stopped. Later turns echo.
fn tool_script(turn: &outcode_harness::mock::Turn) -> Vec<Step> {
    if turn.turn > 1 {
        return echo(turn);
    }
    let call = |id: &str| {
        Step::Emit(AgentEvent::ToolCall {
            id: id.into(),
            call: outcode_proto::ToolCall::Exec { command: "ls".into() },
        })
    };
    let result = |id: &str| {
        Step::Emit(AgentEvent::ToolResult {
            id: id.into(),
            is_error: false,
            output: None,
        })
    };
    vec![call("t1"), call("t2"), Step::Wait, result("t1"), Step::Wait, result("t2"), Step::Wait]
}

#[tokio::test]
async fn after_tool_stops_the_turn_once_its_tool_calls_finish() {
    let (_dir, engine, _) = engine_with(Mock::new().script(tool_script), Duration::from_secs(60), |_| None);
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
    assert!(seen.commands().contains(&RunCommand::SetModes {
        access: outcode_proto::AccessMode::Supervised,
        plan: true
    }));
}

#[tokio::test]
async fn an_idle_run_closes_and_the_next_prompt_resumes_it() {
    let (_dir, engine, seen) = engine(Duration::from_millis(30));
    let chat = engine.create_chat("/a".into(), ChatConfig::default()).unwrap();
    engine.send(&chat.id, "one".into(), Vec::new()).unwrap();
    settle(&engine, &chat.id).await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(!engine.any_live(), "closed once idle");

    engine.send(&chat.id, "two".into(), Vec::new()).unwrap();
    settle(&engine, &chat.id).await;
    let requests = seen.runs();
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[1].resume.as_deref(), Some("s1"));
    assert_eq!(requests[1].cwd, "/a");
    assert_eq!(reply_text(&engine, &chat.id), "echo: two");
}

#[tokio::test]
async fn a_run_that_cant_start_ends_the_turn_with_its_error() {
    let broken = Mock::new().failing(|| HarnessError::NotInstalled("claude"));
    let (_dir, engine, _) = engine_with(broken, Duration::from_secs(60), |_| None);
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
    let (_dir, engine, _) = engine_titled(Duration::from_secs(60), "\"Echo The Prompt\"\n");
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
    let (_dir, engine, seen) = engine(Duration::from_secs(60));
    let chat = engine.create_chat("/a".into(), ChatConfig::default()).unwrap();
    engine.send(&chat.id, "one".into(), Vec::new()).unwrap();
    settle(&engine, &chat.id).await;
    assert!(engine.any_live());

    assert_eq!(engine.set_config(&chat.id, haiku()).unwrap().config, haiku());
    assert!(!engine.any_live(), "an idle run closes at once");
    engine.send(&chat.id, "two".into(), Vec::new()).unwrap();
    settle(&engine, &chat.id).await;

    let requests = seen.runs();
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[1].config, haiku());
    assert_eq!(requests[1].resume.as_deref(), Some("s1"));
}

#[tokio::test]
async fn a_config_changed_mid_turn_applies_from_the_next_prompt() {
    let (_dir, engine, seen) = engine(Duration::from_secs(60));
    let chat = engine.create_chat("/a".into(), ChatConfig::default()).unwrap();
    engine.send(&chat.id, "one".into(), Vec::new()).unwrap();
    engine.set_config(&chat.id, haiku()).unwrap();
    assert!(engine.any_live(), "the running turn goes on");
    settle(&engine, &chat.id).await;
    assert_eq!(reply_text(&engine, &chat.id), "echo: one");
    assert!(!engine.any_live(), "closed once it ended");

    engine.send(&chat.id, "two".into(), Vec::new()).unwrap();
    settle(&engine, &chat.id).await;
    assert_eq!(seen.runs()[1].config, haiku());
}

#[tokio::test]
async fn a_background_subagent_reports_into_the_reply_that_spawned_it() {
    // The first turn launches a subagent in the background; it reports
    // during the second.
    let mock = Mock::new().script(|turn| {
        let inner = |event| {
            Step::Emit(AgentEvent::Subagent {
                parent_tool_id: "s1".into(),
                event: Box::new(event),
            })
        };
        if turn.turn > 1 {
            return vec![
                Step::text("second"),
                inner(AgentEvent::TextDelta { text: "found it".into() }),
                inner(AgentEvent::Done { status: DoneStatus::Completed }),
            ];
        }
        let call = outcode_proto::ToolCall::Subagent {
            description: "scan".into(),
            model: None,
            prompt: None,
            agent: None,
        };
        vec![
            Step::Emit(AgentEvent::ToolCall { id: "s1".into(), call }),
            Step::Emit(AgentEvent::ToolResult {
                id: "s1".into(),
                is_error: false,
                output: Some("Async agent launched".into()),
            }),
        ]
    });
    let (_dir, engine, _) = engine_with(mock, Duration::from_secs(60), |_| None);
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
    let options = WorktreeOptions {
        dir: worktrees.path().to_path_buf(),
        semantic: true,
        prefix: String::new(),
        delete_branch: true,
    };
    let mock = Mock::new().text("fix/login-redirect");
    let seen = mock.seen();
    let hooks = Hooks {
        harnesses: vec![Arc::new(mock)],
        // Only branch names; titles are off.
        text_model: Box::new(|kind| (kind == TextUse::Branch).then(claude_text)),
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
    assert_eq!(seen.runs()[0].cwd, worktree.path);
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

#[tokio::test]
async fn a_chat_runs_on_its_harness_and_switching_starts_a_new_session() {
    let claude = Mock::new();
    let codex = Mock::new().harness(HarnessId::Codex);
    let (on_claude, on_codex) = (claude.seen(), codex.seen());
    let dir = tempfile::tempdir().unwrap();
    let hooks = Hooks {
        harnesses: vec![Arc::new(claude), Arc::new(codex)],
        text_model: Box::new(|_| None),
        idle: Box::new(|| Duration::from_secs(60)),
        worktrees: Box::new(WorktreeOptions::default),
    };
    let engine = Engine::new(Store::open(dir.path()).unwrap(), hooks);
    let chat = engine.create_chat("/a".into(), ChatConfig::default()).unwrap();
    engine.send(&chat.id, "one".into(), Vec::new()).unwrap();
    settle(&engine, &chat.id).await;
    assert_eq!(engine.store().chat(&chat.id).unwrap().unwrap().session_id.as_deref(), Some("s1"));

    let codex_config = ChatConfig {
        harness: HarnessId::Codex,
        ..ChatConfig::default()
    };
    let switched = engine.set_config(&chat.id, codex_config).unwrap();
    assert_eq!(switched.session_id, None, "Codex can't resume Claude's session");
    assert!(!engine.any_live());
    engine.send(&chat.id, "two".into(), Vec::new()).unwrap();
    settle(&engine, &chat.id).await;
    assert_eq!(on_claude.runs().len(), 1);
    let runs = on_codex.runs();
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0].resume, None);
    assert_eq!(reply_text(&engine, &chat.id), "echo: two");
}

#[tokio::test]
async fn a_harness_thats_missing_ends_the_turn_with_an_error() {
    let (_dir, engine, _) = engine(Duration::from_secs(60));
    let config = ChatConfig {
        harness: HarnessId::Codex,
        ..ChatConfig::default()
    };
    let chat = engine.create_chat("/a".into(), config).unwrap();
    engine.send(&chat.id, "hi".into(), Vec::new()).unwrap();
    let messages = engine.store().messages(&chat.id).unwrap();
    assert!(matches!(&messages[1].parts[0], MessagePart::Error { message, .. } if message.contains("codex")));
}
