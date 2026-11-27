//! Against the installed `claude`: `cargo test -p outcode-harness -- --ignored`.

use outcode_harness::{Run, claude};
use outcode_proto::{AgentEvent, DoneStatus, RunRequest, ToolCall};

fn start(prompt: &str) -> Run {
    start_in("", prompt)
}

fn start_in(cwd: &str, prompt: &str) -> Run {
    let request = RunRequest {
        cwd: cwd.into(),
        prompt: prompt.into(),

        ..Default::default()
    };
    claude::run(request, None).expect("claude starts")
}

#[tokio::test]
#[ignore = "runs the real Claude CLI"]
async fn tool_call_comes_back_normalized_with_its_result() {
    let dir = std::env::temp_dir().join(format!("outcode-live-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("note.txt"), "the secret is walrus\n").unwrap();
    let mut run = start_in(
        dir.to_str().unwrap(),
        "Use the Read tool on note.txt, then reply with just the secret word.",
    );
    let mut read = None;
    let mut resolved = false;
    let mut text = String::new();
    loop {
        match run.events.recv().await.expect("event") {
            AgentEvent::ToolCall { id, call: ToolCall::ReadFile { path } } => {
                assert!(path.ends_with("note.txt"), "{path}");
                read = Some(id);
            }
            AgentEvent::ToolResult { id, is_error, output } if Some(&id) == read.as_ref() => {
                assert!(!is_error, "{output:?}");
                assert!(output.unwrap_or_default().contains("walrus"));
                resolved = true;
            }
            AgentEvent::TextDelta { text: delta } => text.push_str(&delta),
            AgentEvent::Error { message } => panic!("error: {message}"),
            AgentEvent::Done { status } => {
                assert_eq!(status, DoneStatus::Completed);
                break;
            }
            _ => {}
        }
    }
    assert!(resolved, "the read never resolved");
    assert!(text.to_lowercase().contains("walrus"), "{text:?}");
    let _ = std::fs::remove_dir_all(&dir);
}

/// One turn's text and how it ended, failing on errors.
async fn turn(run: &mut Run) -> (String, DoneStatus) {
    let mut text = String::new();
    while let Some(event) = run.events.recv().await {
        match event {
            AgentEvent::TextDelta { text: delta } => text.push_str(&delta),
            AgentEvent::Error { message } => panic!("error: {message}"),
            AgentEvent::Done { status } => return (text, status),
            _ => {}
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

    assert!(run.handle.send("Which word did I ask you to remember? Reply with just the word.", Vec::new()));
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
            _ => {}
        }
    }
    run.handle.interrupt();
    assert_eq!(turn(&mut run).await.1, DoneStatus::Interrupted);

    assert!(run.handle.send("Reply with exactly the word pong and nothing else.", Vec::new()));
    let (text, status) = turn(&mut run).await;
    assert_eq!(status, DoneStatus::Completed);
    assert!(text.to_lowercase().contains("pong"), "{text:?}");
}

#[tokio::test]
#[ignore = "runs the real Claude CLI"]
async fn a_new_run_resumes_the_session() {
    let mut run = start("Remember the word otter. Reply with just OK.");
    let mut session = None;
    loop {
        match run.events.recv().await.expect("event") {
            AgentEvent::SessionStarted { session_id } => session = Some(session_id),
            AgentEvent::Error { message } => panic!("error: {message}"),
            AgentEvent::Done { status } => {
                assert_eq!(status, DoneStatus::Completed);
                break;
            }
            _ => {}
        }
    }
    let session = session.expect("the run reports its session");
    run.handle.close();
    assert_eq!(run.events.recv().await, None);

    let request = RunRequest {
        cwd: String::new(),
        prompt: "Which word did I ask you to remember? Reply with just the word.".into(),
        resume: Some(session),
        ..Default::default()
    };
    let mut run = claude::run(request, None).expect("claude starts");
    let (text, status) = turn(&mut run).await;
    assert_eq!(status, DoneStatus::Completed);
    assert!(text.to_lowercase().contains("otter"), "{text:?}");
}

#[tokio::test]
#[ignore = "runs the real Claude CLI"]
async fn a_text_run_answers_without_tools() {
    let prompt = "Write a title for this session. Return only a concise 3-5 word title in Title \
        Case.\n\nSession request (JSON string):\n\"Read note.txt and fix the login form validation\"";
    let mut run = claude::run_text(prompt.into(), Some("haiku"), None).expect("claude starts");
    let mut text = String::new();
    loop {
        match run.events.recv().await.expect("event") {
            AgentEvent::TextDelta { text: delta } => text.push_str(&delta),
            AgentEvent::ToolCall { call, .. } => panic!("it used a tool: {call:?}"),
            AgentEvent::Error { message } => panic!("error: {message}"),
            AgentEvent::Done { status } => {
                assert_eq!(status, DoneStatus::Completed);
                break;
            }
            _ => {}
        }
    }
    run.handle.close();
    assert_eq!(run.events.recv().await, None);
    let words = text.split_whitespace().count();
    assert!((1..=8).contains(&words), "{text:?}");
    eprintln!("title: {text}");
}

#[tokio::test]
#[ignore = "runs the real Claude CLI"]
async fn model_and_effort_are_honored() {
    let request = RunRequest {
        cwd: String::new(),
        prompt: "Reply with exactly the word pong and nothing else.".into(),
        config: outcode_proto::ChatConfig {
            model: Some("claude-haiku-5-5".into()),
            reasoning: Some(outcode_proto::ReasoningLevel::Low),
            ..Default::default()
        },
        ..Default::default()
    };
    let mut run = claude::run(request, None).expect("claude starts");
    let (text, status) = turn(&mut run).await;
    assert_eq!(status, DoneStatus::Completed);
    assert!(text.to_lowercase().contains("pong"), "{text:?}");
}

/// A run on Haiku (quick and cheap) with `config`'s access and plan mode.
fn start_haiku(cwd: &str, prompt: &str, access: outcode_proto::AccessMode, plan: bool) -> Run {
    let request = RunRequest {
        cwd: cwd.into(),
        prompt: prompt.into(),
        config: outcode_proto::ChatConfig {
            model: Some("claude-haiku-5-5".into()),
            reasoning: Some(outcode_proto::ReasoningLevel::Low),
            access,
            plan,
            ..Default::default()
        },
        ..Default::default()
    };
    claude::run(request, None).expect("claude starts")
}

fn scratch(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("outcode-live-{name}-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[tokio::test]
#[ignore = "runs the real Claude CLI"]
async fn supervised_asks_before_a_command_and_runs_it_once_allowed() {
    use outcode_proto::{AccessMode, ApprovalDecision, InputRequest, InputResponse};
    let dir = scratch("approve");
    let mut run = start_haiku(
        dir.to_str().unwrap(),
        "Use the Bash tool to run exactly this command: mkdir approved-dir && echo outcode-approved-42. Then reply with its output.",
        AccessMode::Supervised,
        false,
    );
    let mut asked = false;
    let mut output = String::new();
    loop {
        match run.events.recv().await.expect("event") {
            AgentEvent::InputRequested { request_id, request } => {
                assert!(
                    matches!(&request, InputRequest::Approval { call: Some(ToolCall::Exec { command }), .. } if command.contains("outcode-approved-42")),
                    "{request:?}"
                );
                asked = true;
                assert!(run.handle.answer(request_id, InputResponse::Approval { decision: ApprovalDecision::Allow }));
            }
            AgentEvent::ToolResult { output: Some(o), .. } => output.push_str(&o),
            AgentEvent::Error { message } => panic!("error: {message}"),
            AgentEvent::Done { status } => {
                assert_eq!(status, DoneStatus::Completed);
                break;
            }
            _ => {}
        }
    }
    assert!(asked, "never asked");
    assert!(output.contains("outcode-approved-42"), "{output:?}");
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
#[ignore = "runs the real Claude CLI"]
async fn a_denied_write_never_happens() {
    use outcode_proto::{AccessMode, ApprovalDecision, InputResponse};
    let dir = scratch("deny");
    let mut run = start_haiku(
        dir.to_str().unwrap(),
        "Use the Write tool to create a file named denied.txt containing hi. If you can't, reply with just: refused.",
        AccessMode::Supervised,
        false,
    );
    let mut asked = false;
    loop {
        match run.events.recv().await.expect("event") {
            AgentEvent::InputRequested { request_id, .. } => {
                asked = true;
                run.handle.answer(request_id, InputResponse::Approval { decision: ApprovalDecision::Deny });
            }
            AgentEvent::Error { message } => panic!("error: {message}"),
            AgentEvent::Done { .. } => break,
            _ => {}
        }
    }
    assert!(asked, "never asked");
    assert!(!dir.join("denied.txt").exists(), "the write happened anyway");
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
#[ignore = "runs the real Claude CLI"]
async fn questions_reach_the_user_and_the_answer_reaches_claude() {
    use outcode_proto::{AccessMode, InputRequest, InputResponse, UserInputAnswer};
    let mut run = start_haiku(
        "",
        "Use the AskUserQuestion tool to ask me which color I prefer, with the options Red and Blue. \
         Then reply with just the color I picked.",
        AccessMode::FullAccess,
        false,
    );
    let mut asked = false;
    let mut text = String::new();
    loop {
        match run.events.recv().await.expect("event") {
            AgentEvent::InputRequested { request_id, request: InputRequest::Questions { questions } } => {
                asked = true;
                let answers = vec![UserInputAnswer { question_id: questions[0].id.clone(), labels: vec!["Blue".into()] }];
                run.handle.answer(request_id, InputResponse::Questions { answers });
            }
            AgentEvent::TextDelta { text: t } => text.push_str(&t),
            AgentEvent::Error { message } => panic!("error: {message}"),
            AgentEvent::Done { .. } => break,
            _ => {}
        }
    }
    assert!(asked, "never asked");
    assert!(text.to_lowercase().contains("blue"), "{text:?}");
}

#[tokio::test]
#[ignore = "runs the real Claude CLI"]
async fn plan_mode_asks_to_approve_the_plan() {
    use outcode_proto::{AccessMode, InputRequest, InputResponse};
    let dir = scratch("plan");
    let mut run = start_haiku(
        dir.to_str().unwrap(),
        "Plan how to create a file hello.txt containing hi, then present the plan for approval with ExitPlanMode.",
        AccessMode::FullAccess,
        true,
    );
    let mut plan = None;
    loop {
        match run.events.recv().await.expect("event") {
            AgentEvent::InputRequested { request_id, request: InputRequest::Plan { plan: p } } => {
                plan = Some(p);
                run.handle.answer(request_id, InputResponse::Plan { approve: true, feedback: None });
            }
            AgentEvent::InputRequested { request_id, .. } => {
                run.handle.answer(
                    request_id,
                    InputResponse::Approval { decision: outcode_proto::ApprovalDecision::Allow },
                );
            }
            AgentEvent::Error { message } => panic!("error: {message}"),
            AgentEvent::Done { .. } => break,
            _ => {}
        }
    }
    let plan = plan.expect("never asked to approve a plan");
    assert!(!plan.trim().is_empty());
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
#[ignore = "runs the real Claude CLI"]
async fn the_session_lists_its_commands_and_context_window() {
    let mut run = start_haiku("", "Reply with just OK.", outcode_proto::AccessMode::FullAccess, false);
    let mut commands = Vec::new();
    let mut window = None;
    loop {
        match run.events.recv().await.expect("event") {
            AgentEvent::AvailableCommands { commands: c } => commands = c,
            AgentEvent::ContextUsage { window: Some(w), .. } => window = Some(w),
            AgentEvent::Error { message } => panic!("error: {message}"),
            AgentEvent::Done { .. } => break,
            _ => {}
        }
    }
    assert!(commands.iter().any(|c| c.name == "compact"), "{commands:?}");
    assert!(window.is_some_and(|w| w > 10_000), "{window:?}");
    let probed = claude::commands("", None).await.expect("probe");
    assert!(probed.iter().any(|c| c.name == "compact"));
}

#[tokio::test]
#[ignore = "runs the real Claude CLI"]
async fn attached_files_are_read_without_asking() {
    let dir = scratch("attach");
    let file = dir.join("note.txt");
    std::fs::write(&file, "the password is kumquat\n").unwrap();
    let mut request = RunRequest {
        cwd: dir.to_string_lossy().into_owned(),
        prompt: "What is the password in the attached file? Reply with just the word.".into(),
        attachments: vec![file.to_string_lossy().into_owned()],
        ..Default::default()
    };
    request.config.model = Some("claude-haiku-5-5".into());
    request.config.access = outcode_proto::AccessMode::Supervised;
    let mut run = claude::run(request, None).expect("claude starts");
    let mut text = String::new();
    loop {
        match run.events.recv().await.expect("event") {
            AgentEvent::InputRequested { request, .. } => panic!("asked: {request:?}"),
            AgentEvent::TextDelta { text: t } => text.push_str(&t),
            AgentEvent::Error { message } => panic!("error: {message}"),
            AgentEvent::Done { .. } => break,
            _ => {}
        }
    }
    assert!(text.to_lowercase().contains("kumquat"), "{text:?}");
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
#[ignore = "runs the real Claude CLI"]
async fn attached_images_are_seen_inline() {
    let dir = scratch("image");
    let image = dir.join("logo.png");
    let icon = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../src-tauri/icons/prod/128x128.png");
    std::fs::copy(icon, &image).unwrap();
    let mut request = RunRequest {
        cwd: dir.to_string_lossy().into_owned(),
        prompt: "Look at the attached image, which is included in this message. Without using any tools, \
                 is its background dark or light? Reply with exactly one word: dark or light."
            .into(),
        attachments: vec![image.to_string_lossy().into_owned()],
        ..Default::default()
    };
    request.config.model = Some("claude-haiku-5-5".into());
    let mut run = claude::run(request, None).expect("claude starts");
    let mut text = String::new();
    loop {
        match run.events.recv().await.expect("event") {
            AgentEvent::ToolCall { call, .. } => panic!("used a tool: {call:?}"),
            AgentEvent::TextDelta { text: t } => text.push_str(&t),
            AgentEvent::Error { message } => panic!("error: {message}"),
            AgentEvent::Done { status } => {
                assert_eq!(status, DoneStatus::Completed);
                break;
            }
            _ => {}
        }
    }
    assert!(text.to_lowercase().contains("dark"), "{text:?}");
    let _ = std::fs::remove_dir_all(&dir);
}

/// Runs one turn on `run`, answering approvals with allow, collecting events.
async fn collect_turn(run: &mut Run) -> Vec<AgentEvent> {
    let mut events = Vec::new();
    while let Some(event) = run.events.recv().await {
        if let AgentEvent::InputRequested { request_id, .. } = &event {
            run.handle.answer(
                request_id.clone(),
                outcode_proto::InputResponse::Approval { decision: outcode_proto::ApprovalDecision::Allow },
            );
        }
        if let AgentEvent::Error { message } = &event {
            panic!("error: {message}");
        }
        let done = matches!(event, AgentEvent::Done { .. });
        events.push(event);
        if done {
            return events;
        }
    }
    panic!("the run ended mid-turn");
}

#[tokio::test]
#[ignore = "runs the real Claude CLI"]
async fn compact_summarizes_the_conversation() {
    use outcode_proto::CompactionStatus;
    let mut run = start_haiku("", "Remember the word heron. Reply with just OK.", outcode_proto::AccessMode::FullAccess, false);
    collect_turn(&mut run).await;
    run.handle.send("Also remember the word lynx. Reply with just OK.", Vec::new());
    collect_turn(&mut run).await;
    run.handle.send("/compact", Vec::new());
    let events = collect_turn(&mut run).await;
    let statuses: Vec<CompactionStatus> = events
        .iter()
        .filter_map(|e| match e {
            AgentEvent::Compaction { status, .. } => Some(*status),
            _ => None,
        })
        .collect();
    assert!(statuses.contains(&CompactionStatus::Completed), "{events:?}");
    run.handle.send("Which two words did I ask you to remember? Reply with just them.", Vec::new());
    let text: String = collect_turn(&mut run)
        .await
        .into_iter()
        .filter_map(|e| match e {
            AgentEvent::TextDelta { text } => Some(text),
            _ => None,
        })
        .collect();
    assert!(text.to_lowercase().contains("heron"), "{text:?}");
}

#[tokio::test]
#[ignore = "runs the real Claude CLI"]
async fn subagent_traffic_nests_under_its_spawn() {
    let dir = scratch("subagent");
    std::fs::write(dir.join("alpha.txt"), "a").unwrap();
    let mut run = start_haiku(
        dir.to_str().unwrap(),
        "Use the Agent tool (subagent_type general-purpose) to list the files in the current folder. \
         Then reply with the file names.",
        outcode_proto::AccessMode::FullAccess,
        false,
    );
    let mut events = collect_turn(&mut run).await;
    // A background agent reports after the turn: keep listening until it ends.
    let _ = tokio::time::timeout(std::time::Duration::from_secs(90), async {
        while let Some(event) = run.events.recv().await {
            let spawn_done =
                matches!(&event, AgentEvent::Subagent { event, .. } if matches!(**event, AgentEvent::Done { .. }));
            events.push(event);
            if spawn_done {
                break;
            }
        }
    })
    .await;
    let spawn = events
        .iter()
        .find_map(|e| match e {
            AgentEvent::ToolCall { id, call: ToolCall::Subagent { .. } } => Some(id.clone()),
            _ => None,
        })
        .expect("no subagent spawned");
    assert!(
        events
            .iter()
            .any(|e| matches!(e, AgentEvent::Subagent { parent_tool_id, .. } if *parent_tool_id == spawn)),
        "no traffic under the spawn: {events:?}"
    );
    // Folded, the spawn holds the subagent's thread and has finished.
    let mut parts = Vec::new();
    for event in &events {
        outcode_proto::fold_event(&mut parts, event);
    }
    assert!(parts.iter().any(|p| matches!(
        p,
        outcode_proto::MessagePart::Tool { thread, subagent: Some(s), .. }
            if !thread.is_empty() && *s != outcode_proto::SubagentStatus::Running
    )), "{parts:?}");
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
#[ignore = "runs the real Claude CLI"]
async fn background_tasks_outlive_the_turn_and_can_be_stopped() {
    let mut run = start_haiku(
        "",
        "Use the Bash tool with run_in_background set to true to run: sleep 120. \
         Do not wait for it; reply with just: started.",
        outcode_proto::AccessMode::FullAccess,
        false,
    );
    let mut tasks = Vec::new();
    for event in collect_turn(&mut run).await {
        if let AgentEvent::BackgroundTasks { tasks: t } = event {
            tasks = t;
        }
    }
    let task = tasks.first().expect("no background task listed after the turn").clone();
    assert_eq!(task.kind, outcode_proto::BackgroundTaskKind::Shell);
    let output = task.output_file.as_deref().expect("no output file for the shell");
    assert!(std::path::Path::new(output).is_file(), "{output}");
    run.handle.stop_task(task.id.clone());
    let emptied = tokio::time::timeout(std::time::Duration::from_secs(30), async {
        while let Some(event) = run.events.recv().await {
            if let AgentEvent::BackgroundTasks { tasks } = event
                && tasks.iter().all(|t| t.id != task.id)
            {
                return true;
            }
        }
        false
    })
    .await;
    assert_eq!(emptied, Ok(true), "the task was never stopped");
}

#[tokio::test]
#[ignore = "runs the real Claude CLI"]
async fn configured_environment_reaches_the_agent() {
    claude::configure("OUTCODE_LIVE_MARK=walrus-42", "", "");
    let mut run = start_haiku(
        "",
        "Use the Bash tool to run: echo $OUTCODE_LIVE_MARK . Reply with just its output.",
        outcode_proto::AccessMode::FullAccess,
        false,
    );
    let text: String = collect_turn(&mut run)
        .await
        .into_iter()
        .filter_map(|e| match e {
            AgentEvent::ToolResult { output, .. } => output,
            _ => None,
        })
        .collect();
    claude::configure("", "", "");
    assert!(text.contains("walrus-42"), "{text:?}");
}

#[tokio::test]
#[ignore = "runs the real Claude CLI"]
async fn a_completed_turn_is_followed_by_a_prompt_suggestion() {
    let dir = std::env::temp_dir().join(format!("outcode-live-suggest-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let request = RunRequest {
        cwd: dir.display().to_string(),
        prompt: "I'm building a todo app in React. Give me a three-step plan in three short lines. Don't use tools."
            .into(),
        config: outcode_proto::ChatConfig {
            model: Some("haiku".into()),
            ..Default::default()
        },
        prompt_suggestions: true,
        ..Default::default()
    };
    let mut run = claude::run(request, None).expect("claude starts");
    // The model leaves some turns without one (no clear next step).
    let follow_ups = ["Expand step 1 in two sentences.", "Now step 2, briefly.", "And step 3."];
    let mut suggestion = None;
    for follow_up in follow_ups {
        assert_eq!(turn(&mut run).await.1, DoneStatus::Completed);
        // It comes a few seconds after the turn's end, if at all.
        let wait = tokio::time::timeout(std::time::Duration::from_secs(20), async {
            while let Some(event) = run.events.recv().await {
                if let AgentEvent::PromptSuggestion { text } = event {
                    return Some(text);
                }
            }
            None
        });
        if let Ok(Some(text)) = wait.await {
            suggestion = Some(text);
            break;
        }
        run.handle.send(follow_up, Vec::new());
    }
    let text = suggestion.expect("no turn was followed by a suggestion");
    assert!(!text.trim().is_empty());
    eprintln!("suggestion: {text}");
    run.handle.close();
    let _ = std::fs::remove_dir_all(&dir);
}
