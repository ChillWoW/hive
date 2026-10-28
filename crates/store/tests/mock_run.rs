//! Records two turns of the mock harness through the store, as the engine
//! will, and checks that the journal and the saved messages agree.

use hive_harness::{Harness, MockHarness, Run};
use hive_proto::{
    fold_event, AgentEvent, ChatConfig, CommandPayload, CommandStatus, HarnessId, MessagePart,
    MessageRole, MessageStatus, RunRequest, SandboxLevel, ToolCall, UserInputAnswer,
};
use hive_store::{Store, Turn};

/// Records events until the turn's `Done`, answering its question.
async fn record_turn(store: &Store, run: &mut Run, turn: &mut Turn) {
    while let Some(event) = run.events.recv().await {
        store.record(turn, &event).unwrap();
        match event {
            AgentEvent::InputRequested {
                request_id,
                questions,
            } => {
                let command = store
                    .issue_command(
                        &turn.chat_id,
                        CommandPayload::Answer {
                            request_id: request_id.clone(),
                            answers: vec![UserInputAnswer {
                                question_id: questions[0].id.clone(),
                                labels: vec![questions[0].options[1].clone()],
                            }],
                        },
                    )
                    .unwrap();
                let CommandPayload::Answer {
                    request_id,
                    answers,
                } = command.payload
                else {
                    unreachable!()
                };
                run.handle.answer(request_id, answers);
                store
                    .resolve_command(&command.id, CommandStatus::Applied, None)
                    .unwrap();
            }
            AgentEvent::Done { .. } => return,
            _ => {}
        }
    }
    panic!("the run ended before its Done");
}

#[tokio::test]
async fn two_mock_turns_persist_and_match_their_journal() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path()).unwrap();
    let chat = store
        .create_chat(
            "/demo",
            ChatConfig {
                harness: HarnessId::Mock,
                model: None,
                reasoning: None,
                model_options: Default::default(),
                sandbox: SandboxLevel::WorkspaceWrite,
                access: Default::default(),
                plan: false,
            },
        )
        .unwrap();

    let mut run = MockHarness::with_speed(0.0)
        .run(RunRequest {
            harness: HarnessId::Mock,
            prompt: "first".into(),
            cwd: chat.cwd.clone(),
            sandbox: SandboxLevel::WorkspaceWrite,
            model: None,
            reasoning: None,
            model_options: Default::default(),
            auto_approve: false,
            access: Default::default(),
            plan: false,
            resume: None,
            attachments: Vec::new(),
        })
        .unwrap();
    let mut first = store.start_turn(&chat.id, "first", None).unwrap();
    record_turn(&store, &mut run, &mut first).await;

    run.handle.send("second");
    let mut second = store.start_turn(&chat.id, "second", None).unwrap();
    record_turn(&store, &mut run, &mut second).await;
    run.handle.close();

    // Reopened, as after a restart.
    drop(store);
    let store = Store::open(dir.path()).unwrap();
    assert!(store.recover().unwrap().aborted_messages.is_empty());

    let messages = store.messages(&chat.id).unwrap();
    let roles: Vec<MessageRole> = messages.iter().map(|m| m.role).collect();
    use MessageRole::{Assistant, User};
    assert_eq!(roles, [User, Assistant, User, Assistant]);

    let reply = &messages[1];
    assert_eq!(reply.status, Some(MessageStatus::Complete));
    assert!(reply.duration_ms.is_some());
    assert!(reply
        .parts
        .iter()
        .any(|p| matches!(p, MessagePart::Input { resolved: true, .. })));
    assert!(reply.parts.iter().any(|p| matches!(
        p,
        MessagePart::Tool {
            call: ToolCall::Subagent { .. },
            subagent: Some(_),
            ..
        }
    )));
    assert!(reply.parts.iter().any(|p| matches!(
        p,
        MessagePart::Text { text, .. } if text.contains("Going with \"Change the test\"")
    )));

    // Each saved message is exactly its journal lines, folded.
    let lines = store.journal().read(&chat.id).unwrap();
    for message in [&messages[1], &messages[3]] {
        let mut parts = Vec::new();
        for line in lines.iter().filter(|l| l.message_id == message.id) {
            fold_event(&mut parts, &line.event);
        }
        assert_eq!(parts, message.parts);
    }

    let chat = store.chat(&chat.id).unwrap().unwrap();
    assert_eq!(chat.harness_session_id.as_deref(), Some("mock-session"));
    let commands = store.commands(&chat.id).unwrap();
    assert_eq!(commands.len(), 2);
    assert!(commands.iter().all(|c| c.status == CommandStatus::Applied));
}
