//! The engine driving `MockHarness` end to end: commands in, store and
//! watchers out.

use std::sync::Arc;
use std::time::Duration;

use hive_engine::{Engine, EngineConfig, RESUME_PROMPT};
use hive_harness::{Harness, MockHarness};
use hive_proto::{
    fold_event, AgentEvent, ChatConfig, ChatsUpdate, Command, CommandPayload, CommandStatus,
    DoneStatus, HarnessId, Message, MessagePart, MessageRole, MessageStatus, MessagesUpdate,
    SandboxLevel, SessionStatus, UserInputAnswer,
};
use hive_store::Store;
use tokio::sync::mpsc;
use tokio::time::timeout;

const WAIT: Duration = Duration::from_secs(10);

fn config(harness: HarnessId) -> ChatConfig {
    ChatConfig {
        harness,
        model: None,
        reasoning: None,
        model_options: Default::default(),
        sandbox: SandboxLevel::WorkspaceWrite,
        access: Default::default(),
        plan: false,
    }
}

fn engine_in(dir: &tempfile::TempDir, speed: f64, config: EngineConfig) -> Engine {
    let harness: Arc<dyn Harness> = Arc::new(MockHarness::with_speed(speed));
    Engine::new(
        Store::open(dir.path()).unwrap(),
        vec![harness],
        config,
        tokio::runtime::Handle::current(),
    )
}

fn engine(speed: f64) -> (tempfile::TempDir, Engine) {
    let dir = tempfile::tempdir().unwrap();
    let engine = engine_in(&dir, speed, EngineConfig::default());
    (dir, engine)
}

fn send(prompt: &str) -> CommandPayload {
    CommandPayload::Send {
        prompt: prompt.into(),
        message_id: format!("user-{prompt}"),
    }
}

fn watch_messages(engine: &Engine, chat_id: &str) -> mpsc::UnboundedReceiver<MessagesUpdate> {
    let (tx, rx) = mpsc::unbounded_channel();
    engine
        .watch_messages(chat_id, move |u| tx.send(u).is_ok())
        .unwrap();
    rx
}

fn watch_chats(engine: &Engine) -> mpsc::UnboundedReceiver<ChatsUpdate> {
    let (tx, rx) = mpsc::unbounded_channel();
    engine.watch_chats(move |u| tx.send(u).is_ok()).unwrap();
    rx
}

/// Receives until `stop` matches, returning everything seen.
async fn until<T>(rx: &mut mpsc::UnboundedReceiver<T>, stop: impl Fn(&T) -> bool) -> Vec<T> {
    let mut seen = Vec::new();
    timeout(WAIT, async {
        while let Some(update) = rx.recv().await {
            let done = stop(&update);
            seen.push(update);
            if done {
                return;
            }
        }
        panic!("the watcher closed");
    })
    .await
    .expect("timed out");
    seen
}

fn is_input(u: &MessagesUpdate) -> bool {
    matches!(
        u,
        MessagesUpdate::Event {
            event: AgentEvent::InputRequested { .. },
            ..
        }
    )
}

fn is_done(u: &MessagesUpdate) -> bool {
    matches!(
        u,
        MessagesUpdate::Event {
            event: AgentEvent::Done { .. },
            ..
        }
    )
}

fn request_id(updates: &[MessagesUpdate]) -> String {
    updates
        .iter()
        .rev()
        .find_map(|u| match u {
            MessagesUpdate::Event {
                event: AgentEvent::InputRequested { request_id, .. },
                ..
            } => Some(request_id.clone()),
            _ => None,
        })
        .unwrap()
}

fn answer(request_id: String) -> CommandPayload {
    CommandPayload::Answer {
        request_id,
        answers: vec![UserInputAnswer {
            question_id: "fix".into(),
            labels: vec!["Change the test".into()],
        }],
    }
}

/// What a UI holding this watcher's updates would show.
#[derive(Default)]
struct View {
    messages: Vec<Message>,
    commands: Vec<Command>,
}

impl View {
    fn apply(&mut self, update: MessagesUpdate) {
        match update {
            MessagesUpdate::Snapshot { messages, pending } => {
                self.messages = messages;
                self.commands = pending;
            }
            MessagesUpdate::Message { message } => {
                match self.messages.iter_mut().find(|m| m.id == message.id) {
                    Some(m) => *m = message,
                    None => self.messages.push(message),
                }
            }
            MessagesUpdate::Event { message_id, event } => {
                let message = self.messages.iter_mut().find(|m| m.id == message_id);
                fold_event(
                    &mut message.expect("event for an unknown message").parts,
                    &event,
                );
            }
            MessagesUpdate::Command { command } => {
                match self.commands.iter_mut().find(|c| c.id == command.id) {
                    Some(c) => *c = command,
                    None => self.commands.push(command),
                }
            }
            MessagesUpdate::Queue { .. } => {}
        }
    }
}

#[tokio::test]
async fn a_turn_runs_answers_and_matches_the_store() {
    let (_dir, engine) = engine(0.0);
    let chat = engine
        .create_chat("/demo", config(HarnessId::Mock))
        .unwrap();
    let mut chats = watch_chats(&engine);
    let mut updates = watch_messages(&engine, &chat.id);

    let sent = engine.queue_command(&chat.id, send("hi")).unwrap();
    assert_eq!(sent.status, CommandStatus::Applied);

    let mut seen = until(&mut updates, is_input).await;
    let applied = engine
        .queue_command(&chat.id, answer(request_id(&seen)))
        .unwrap();
    assert_eq!(applied.status, CommandStatus::Applied);
    seen.extend(until(&mut updates, is_done).await);
    // The finished reply, whole.
    seen.extend(
        until(&mut updates, |u| {
            matches!(u, MessagesUpdate::Message { .. })
        })
        .await,
    );

    let mut view = View::default();
    for update in seen {
        view.apply(update);
    }
    let stored = engine.store().messages(&chat.id).unwrap();
    assert_eq!(view.messages, stored);
    assert_eq!(stored[0].id, "user-hi");
    assert_eq!(stored[1].status, Some(MessageStatus::Complete));
    assert!(stored[1].duration_ms.is_some());

    let mut statuses: Vec<SessionStatus> = until(&mut chats, |u| {
        matches!(u, ChatsUpdate::Session { session: Some(s), .. } if s.status == SessionStatus::Idle)
    })
    .await
    .into_iter()
    .filter_map(|u| match u {
        ChatsUpdate::Session { session, .. } => session.map(|s| s.status),
        _ => None,
    })
    .collect();
    // Context updates re-send the session with its status unchanged.
    statuses.dedup();
    use SessionStatus::{AwaitingInput, Idle, Working};
    assert_eq!(statuses, [Working, AwaitingInput, Working, Idle]);
    assert_eq!(
        engine.chats().unwrap()[0].harness_session_id.as_deref(),
        Some("mock-session")
    );
}

#[tokio::test]
async fn a_prompt_sent_mid_turn_waits_for_its_own_turn() {
    let (_dir, engine) = engine(0.0);
    let chat = engine
        .create_chat("/demo", config(HarnessId::Mock))
        .unwrap();
    let mut updates = watch_messages(&engine, &chat.id);

    engine.queue_command(&chat.id, send("first")).unwrap();
    let seen = until(&mut updates, is_input).await;
    let steer = engine.queue_command(&chat.id, send("second")).unwrap();
    assert_eq!(steer.status, CommandStatus::Pending);

    engine
        .queue_command(&chat.id, answer(request_id(&seen)))
        .unwrap();
    until(&mut updates, |u| {
        matches!(u, MessagesUpdate::Command { command } if command.id == steer.id && command.status == CommandStatus::Applied)
    })
    .await;
    let seen = until(&mut updates, is_input).await;
    engine
        .queue_command(&chat.id, answer(request_id(&seen)))
        .unwrap();
    until(&mut updates, is_done).await;

    let messages = engine.store().messages(&chat.id).unwrap();
    let roles: Vec<MessageRole> = messages.iter().map(|m| m.role).collect();
    use MessageRole::{Assistant, User};
    assert_eq!(roles, [User, Assistant, User, Assistant]);
    assert_eq!(messages[2].id, "user-second");
    assert!(messages
        .iter()
        .filter(|m| m.role == Assistant)
        .all(|m| m.status == Some(MessageStatus::Complete)));
}

fn settled(u: &MessagesUpdate, id: &str, status: CommandStatus) -> bool {
    matches!(u, MessagesUpdate::Command { command } if command.id == id && command.status == status)
}

fn user_ids(engine: &Engine, chat_id: &str) -> Vec<String> {
    engine
        .store()
        .messages(chat_id)
        .unwrap()
        .into_iter()
        .filter(|m| m.role == MessageRole::User)
        .map(|m| m.id)
        .collect()
}

#[tokio::test]
async fn the_queue_is_reordered_withdrawn_and_runs_in_order() {
    let (_dir, engine) = engine(0.0);
    let chat = engine
        .create_chat("/demo", config(HarnessId::Mock))
        .unwrap();
    let mut updates = watch_messages(&engine, &chat.id);

    engine.queue_command(&chat.id, send("first")).unwrap();
    let seen = until(&mut updates, is_input).await;
    let a = engine.queue_command(&chat.id, send("a")).unwrap();
    let b = engine.queue_command(&chat.id, send("b")).unwrap();
    let c = engine.queue_command(&chat.id, send("c")).unwrap();

    engine
        .reorder_queue(&chat.id, &[c.id.clone(), a.id.clone()])
        .unwrap();
    until(&mut updates, |u| {
        matches!(u, MessagesUpdate::Queue { command_ids } if *command_ids == [c.id.clone(), a.id.clone(), b.id.clone()])
    })
    .await;
    // A late watcher sees the same order.
    let mut late = watch_messages(&engine, &chat.id);
    match late.recv().await.unwrap() {
        MessagesUpdate::Snapshot { pending, .. } => {
            let ids: Vec<_> = pending.iter().map(|c| c.id.clone()).collect();
            assert_eq!(ids, [c.id.clone(), a.id.clone(), b.id.clone()]);
        }
        other => panic!("expected a snapshot, got {other:?}"),
    }

    let cancelled = engine.cancel_queued(&chat.id, &a.id).unwrap();
    assert_eq!(cancelled.status, CommandStatus::Cancelled);
    assert!(engine.cancel_queued(&chat.id, &a.id).is_err());

    // c, then b, each a turn of its own.
    let mut request = request_id(&seen);
    for next in [&c, &b] {
        engine.queue_command(&chat.id, answer(request)).unwrap();
        until(&mut updates, |u| {
            settled(u, &next.id, CommandStatus::Applied)
        })
        .await;
        request = request_id(&until(&mut updates, is_input).await);
    }
    engine.queue_command(&chat.id, answer(request)).unwrap();
    until(&mut updates, is_done).await;
    assert_eq!(
        user_ids(&engine, &chat.id),
        ["user-first", "user-c", "user-b"]
    );
}

#[tokio::test]
async fn a_stopped_turn_holds_the_queue_and_send_now_hands_over() {
    let (_dir, engine) = engine(0.0);
    let chat = engine
        .create_chat("/demo", config(HarnessId::Mock))
        .unwrap();
    let mut updates = watch_messages(&engine, &chat.id);

    engine.queue_command(&chat.id, send("first")).unwrap();
    until(&mut updates, is_input).await;
    let a = engine.queue_command(&chat.id, send("a")).unwrap();
    let b = engine.queue_command(&chat.id, send("b")).unwrap();

    // Stopping holds the queue.
    engine
        .queue_command(&chat.id, CommandPayload::Interrupt)
        .unwrap();
    until(&mut updates, is_done).await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(user_ids(&engine, &chat.id), ["user-first"]);

    // Idle: send now starts it at once, the rest stays held.
    engine.send_queued_now(&chat.id, &b.id).unwrap();
    until(&mut updates, |u| settled(u, &b.id, CommandStatus::Applied)).await;
    until(&mut updates, is_input).await;
    assert_eq!(user_ids(&engine, &chat.id), ["user-first", "user-b"]);

    // Mid-turn: send now interrupts, and the queue carries on with it.
    let c = engine.queue_command(&chat.id, send("c")).unwrap();
    engine.send_queued_now(&chat.id, &c.id).unwrap();
    until(&mut updates, |u| settled(u, &c.id, CommandStatus::Applied)).await;
    let messages = engine.store().messages(&chat.id).unwrap();
    assert_eq!(messages[3].status, Some(MessageStatus::Aborted));
    assert_eq!(
        user_ids(&engine, &chat.id),
        ["user-first", "user-b", "user-c"]
    );
    let seen = until(&mut updates, is_input).await;
    engine
        .queue_command(&chat.id, answer(request_id(&seen)))
        .unwrap();
    until(&mut updates, |u| settled(u, &a.id, CommandStatus::Applied)).await;

    assert!(engine.send_queued_now(&chat.id, &a.id).is_err());
}

#[tokio::test]
async fn interrupt_stops_the_turn_and_is_rejected_when_idle() {
    let (_dir, engine) = engine(1.0);
    let chat = engine
        .create_chat("/demo", config(HarnessId::Mock))
        .unwrap();
    let mut updates = watch_messages(&engine, &chat.id);

    let idle = engine
        .queue_command(&chat.id, CommandPayload::Interrupt)
        .unwrap();
    assert_eq!(idle.status, CommandStatus::Rejected);

    engine.queue_command(&chat.id, send("hi")).unwrap();
    until(&mut updates, |u| matches!(u, MessagesUpdate::Event { .. })).await;
    let interrupt = engine
        .queue_command(&chat.id, CommandPayload::Interrupt)
        .unwrap();
    assert_eq!(interrupt.status, CommandStatus::Applied);
    let seen = until(&mut updates, is_done).await;
    assert!(matches!(
        seen.last(),
        Some(MessagesUpdate::Event {
            event: AgentEvent::Done {
                status: DoneStatus::Interrupted,
                ..
            },
            ..
        })
    ));
    let reply = &engine.store().messages(&chat.id).unwrap()[1];
    assert_eq!(reply.status, Some(MessageStatus::Aborted));
}

#[tokio::test]
async fn bad_commands_are_rejected() {
    let (_dir, engine) = engine(0.0);
    let chat = engine
        .create_chat("/demo", config(HarnessId::ClaudeCode))
        .unwrap();
    let unsupported = engine.queue_command(&chat.id, send("hi")).unwrap();
    assert_eq!(unsupported.status, CommandStatus::Rejected);
    assert!(engine.store().messages(&chat.id).unwrap().is_empty());

    let stale = engine
        .queue_command(&chat.id, answer("nope".into()))
        .unwrap();
    assert_eq!(stale.status, CommandStatus::Rejected);
    assert!(engine.queue_command("missing", send("hi")).is_err());
}

#[tokio::test]
async fn a_late_watcher_snapshot_joins_the_stream_without_gaps() {
    let (_dir, engine) = engine(0.2);
    let chat = engine
        .create_chat("/demo", config(HarnessId::Mock))
        .unwrap();
    let mut early = watch_messages(&engine, &chat.id);
    engine.queue_command(&chat.id, send("hi")).unwrap();
    // Mid-stream: some text folded, little of it saved yet.
    until(&mut early, |u| {
        matches!(
            u,
            MessagesUpdate::Event {
                event: AgentEvent::TextDelta { .. },
                ..
            }
        )
    })
    .await;

    let mut late = watch_messages(&engine, &chat.id);
    let mut seen = until(&mut late, is_input).await;
    engine
        .queue_command(&chat.id, answer(request_id(&seen)))
        .unwrap();
    seen.extend(until(&mut late, is_done).await);

    let mut view = View::default();
    for update in seen {
        view.apply(update);
    }
    let stored = engine.store().messages(&chat.id).unwrap();
    assert_eq!(view.messages[1].parts, stored[1].parts);
}

#[tokio::test]
async fn an_idle_run_closes_and_the_next_prompt_starts_another() {
    let dir = tempfile::tempdir().unwrap();
    let engine = engine_in(
        &dir,
        0.0,
        EngineConfig {
            idle_timeout: Duration::from_millis(50),
            ..Default::default()
        },
    );
    let chat = engine
        .create_chat("/demo", config(HarnessId::Mock))
        .unwrap();
    let mut chats = watch_chats(&engine);
    let mut updates = watch_messages(&engine, &chat.id);

    for prompt in ["first", "second"] {
        engine.queue_command(&chat.id, send(prompt)).unwrap();
        let seen = until(&mut updates, is_input).await;
        // A fresh run opens with its session.
        assert!(seen.iter().any(|u| matches!(
            u,
            MessagesUpdate::Event {
                event: AgentEvent::SessionStarted { .. },
                ..
            }
        )));
        engine
            .queue_command(&chat.id, answer(request_id(&seen)))
            .unwrap();
        until(&mut updates, is_done).await;
        until(&mut chats, |u| {
            matches!(u, ChatsUpdate::Session { session: None, .. })
        })
        .await;
    }
    assert_eq!(engine.store().messages(&chat.id).unwrap().len(), 4);
}

#[tokio::test]
async fn start_resumes_a_turn_cut_short_by_exit() {
    let dir = tempfile::tempdir().unwrap();
    let chat_id = {
        let store = Store::open(dir.path()).unwrap();
        let chat = store.create_chat("/demo", config(HarnessId::Mock)).unwrap();
        let mut turn = store.start_turn(&chat.id, "hi", None).unwrap();
        for event in [
            AgentEvent::SessionStarted {
                harness: HarnessId::Mock,
                model: "mock-1".into(),
                cwd: "/demo".into(),
                session_id: "mock-session".into(),
                tools: vec![],
            },
            AgentEvent::TextDelta {
                text: "partial".into(),
            },
        ] {
            store.record(&mut turn, &event).unwrap();
        }
        chat.id
        // Dropped mid-turn: Hive "crashed".
    };

    let engine = engine_in(
        &dir,
        0.0,
        EngineConfig {
            resume_interrupted: true,
            ..Default::default()
        },
    );
    let recovery = engine.start().unwrap();
    assert_eq!(recovery.aborted_messages.len(), 1);

    let messages = engine.store().messages(&chat_id).unwrap();
    assert_eq!(messages.len(), 4);
    assert_eq!(messages[1].status, Some(MessageStatus::Aborted));
    assert!(matches!(
        &messages[2].parts[0],
        MessagePart::Text { text, .. } if text == RESUME_PROMPT
    ));
    let commands = engine.store().commands(&chat_id).unwrap();
    assert_eq!(commands.len(), 1);
    assert_eq!(commands[0].status, CommandStatus::Applied);
}

#[tokio::test]
async fn catalogs_list_registered_harnesses() {
    let (_dir, engine) = engine(0.0);
    let catalogs = engine.catalogs();
    assert_eq!(catalogs.len(), 1);
    assert_eq!(catalogs[0].id, HarnessId::Mock);
    assert!(!catalogs[0].models.is_empty());
}

#[tokio::test]
async fn a_session_carries_the_runs_slash_commands() {
    let (_dir, engine) = engine(0.0);
    let chat = engine
        .create_chat("/demo", config(HarnessId::Mock))
        .unwrap();
    let mut chats = watch_chats(&engine);
    engine.queue_command(&chat.id, send("hi")).unwrap();
    until(&mut chats, |u| {
        matches!(u, ChatsUpdate::Session { session: Some(s), .. } if !s.commands.is_empty())
    })
    .await;
}

#[tokio::test]
async fn a_config_change_restarts_the_run_after_its_turn() {
    let (_dir, engine) = engine(0.0);
    let chat = engine
        .create_chat("/demo", config(HarnessId::Mock))
        .unwrap();
    let mut chats = watch_chats(&engine);
    let mut updates = watch_messages(&engine, &chat.id);

    engine.queue_command(&chat.id, send("first")).unwrap();
    let seen = until(&mut updates, is_input).await;

    // Mid-turn: saved now, the run lives until the turn ends.
    let changed = ChatConfig {
        model: Some("mock-mini".into()),
        ..config(HarnessId::Mock)
    };
    let saved = engine.update_config(&chat.id, changed.clone()).unwrap();
    assert_eq!(saved.config, changed);
    assert_eq!(engine.store().chat(&chat.id).unwrap().unwrap().config, changed);

    engine
        .queue_command(&chat.id, answer(request_id(&seen)))
        .unwrap();
    until(&mut updates, is_done).await;
    until(&mut chats, |u| {
        matches!(u, ChatsUpdate::Session { session: None, .. })
    })
    .await;

    // The next prompt starts a fresh run on the new model.
    engine.queue_command(&chat.id, send("second")).unwrap();
    let seen = until(&mut updates, is_input).await;
    assert!(seen.iter().any(|u| matches!(
        u,
        MessagesUpdate::Event {
            event: AgentEvent::SessionStarted { model, .. },
            ..
        } if model == "mock-mini"
    )));
}

#[tokio::test]
async fn a_completed_first_turn_titles_the_chat() {
    let (_dir, engine) = engine(0.0);
    let chat = engine
        .create_chat("/demo", config(HarnessId::Mock))
        .unwrap();
    let mut chats = watch_chats(&engine);
    let mut updates = watch_messages(&engine, &chat.id);

    engine
        .queue_command(&chat.id, send("fix the login flow please"))
        .unwrap();
    let seen = until(&mut updates, is_input).await;
    engine
        .queue_command(&chat.id, answer(request_id(&seen)))
        .unwrap();
    until(&mut updates, is_done).await;

    until(
        &mut chats,
        |u| matches!(u, ChatsUpdate::Chat { chat } if chat.title.is_some()),
    )
    .await;
    let titled = engine.store().chat(&chat.id).unwrap().unwrap();
    assert_eq!(titled.title.as_deref(), Some("Fix The Login Flow"));
}

#[tokio::test]
async fn without_auto_titles_the_prompt_names_the_chat() {
    let (_dir, engine) = engine(0.0);
    engine.set_auto_title(false);
    let chat = engine
        .create_chat("/demo", config(HarnessId::Mock))
        .unwrap();
    let mut chats = watch_chats(&engine);
    let mut updates = watch_messages(&engine, &chat.id);

    engine
        .queue_command(&chat.id, send("fix the login flow please"))
        .unwrap();
    let seen = until(&mut updates, is_input).await;
    engine
        .queue_command(&chat.id, answer(request_id(&seen)))
        .unwrap();
    until(&mut updates, is_done).await;

    until(
        &mut chats,
        |u| matches!(u, ChatsUpdate::Chat { chat } if chat.title.is_some()),
    )
    .await;
    let titled = engine.store().chat(&chat.id).unwrap().unwrap();
    assert_eq!(titled.title.as_deref(), Some("fix the login flow please"));
}

#[tokio::test]
async fn chats_are_renamed_pinned_archived_seen_and_deleted() {
    let (_dir, engine) = engine(0.0);
    let chat = engine
        .create_chat("/demo", config(HarnessId::Mock))
        .unwrap();
    let mut chats = watch_chats(&engine);
    until(&mut chats, |u| matches!(u, ChatsUpdate::Snapshot { .. })).await;

    let renamed = engine
        .rename_chat(&chat.id, Some("  Mine  ".into()))
        .unwrap();
    assert_eq!(renamed.title.as_deref(), Some("Mine"));
    let cleared = engine.rename_chat(&chat.id, Some(" ".into())).unwrap();
    assert_eq!(cleared.title, None);

    let pinned = engine.set_pinned(&chat.id, true).unwrap();
    let pinned_at = pinned.pinned_at.expect("pinned");
    // Pinning again keeps its place.
    assert_eq!(
        engine.set_pinned(&chat.id, true).unwrap().pinned_at,
        Some(pinned_at)
    );
    let archived = engine.set_archived(&chat.id, true).unwrap();
    assert!(archived.archived);
    assert_eq!(archived.pinned_at, None, "archiving unpins");

    // A new turn unarchives and leaves the chat unseen until it's viewed.
    let mut updates = watch_messages(&engine, &chat.id);
    engine.queue_command(&chat.id, send("hi")).unwrap();
    let request = request_id(&until(&mut updates, is_input).await);
    engine.queue_command(&chat.id, answer(request)).unwrap();
    until(&mut updates, is_done).await;
    let after = engine.chats().unwrap().remove(0);
    assert!(!after.archived);
    assert!(after.unseen());
    assert!(!engine.mark_seen(&chat.id).unwrap().unseen());

    engine.delete_chat(&chat.id).unwrap();
    assert!(engine.chats().unwrap().is_empty());
    until(&mut chats, |u| {
        matches!(u, ChatsUpdate::Removed { chat_id } if *chat_id == chat.id)
    })
    .await;
    assert!(engine.delete_chat(&chat.id).is_err());
}
