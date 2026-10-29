//! Drives a harness from the terminal and prints its event stream.
//!
//!     cargo run -p hive-harness --bin hive-run -- [options] <prompt>
//!
//! Options:
//!     --mock              Use the scripted mock instead of `claude`
//!     --model <id>        Model to run
//!     --effort <level>    minimal | low | medium | high | xhigh | max
//!     --sandbox <level>   read-only | workspace-write (default) | danger-full-access
//!     --cwd <dir>         Working directory (default: current)
//!     --resume <id>       Continue a Claude session
//!     --attach <path>     Send a file with the prompt (repeatable)
//!     --yes               Approve every permission prompt
//!     --json              Print raw AgentEvent JSON lines
//!
//! Questions are answered on stdin. After each turn, type a follow-up
//! prompt, or press Enter to quit. Ctrl+C interrupts the running turn.

use std::io::{BufRead, Write};

use hive_harness::{ClaudeHarness, Harness, MockHarness, RunHandle};
use hive_proto::{
    AgentEvent, HarnessId, ReasoningLevel, RunRequest, SandboxLevel, ToolCall, UserInputAnswer,
    UserInputQuestion,
};
use tokio::sync::mpsc;

const DIM: &str = "\x1b[2m";
const RED: &str = "\x1b[31m";
const GREEN: &str = "\x1b[32m";
const YELLOW: &str = "\x1b[33m";
const CYAN: &str = "\x1b[36m";
const RESET: &str = "\x1b[0m";

struct Options {
    mock: bool,
    json: bool,
    request: RunRequest,
}

fn parse_args() -> Result<Options, String> {
    let mut args = std::env::args().skip(1);
    let mut mock = false;
    let mut json = false;
    let mut request = RunRequest {
        harness: HarnessId::ClaudeCode,
        prompt: String::new(),
        cwd: std::env::current_dir()
            .map(|d| d.display().to_string())
            .unwrap_or_default(),
        sandbox: SandboxLevel::WorkspaceWrite,
        model: None,
        reasoning: None,
        model_options: Default::default(),
        auto_approve: false,
        access: Default::default(),
        plan: false,
        resume: None,
        attachments: Vec::new(),
    };
    let mut prompt = Vec::new();
    while let Some(arg) = args.next() {
        let mut value = || args.next().ok_or(format!("{arg} needs a value"));
        match arg.as_str() {
            "--mock" => mock = true,
            "--json" => json = true,
            "--yes" => request.auto_approve = true,
            "--model" => request.model = Some(value()?),
            "--cwd" => request.cwd = value()?,
            "--resume" => request.resume = Some(value()?),
            "--attach" => {
                let path = std::path::PathBuf::from(value()?);
                let path = std::path::absolute(&path).map_err(|e| format!("--attach {}: {e}", path.display()))?;
                request.attachments.push(path.display().to_string());
            }
            "--effort" => {
                request.reasoning = Some(
                    serde_json::from_value::<ReasoningLevel>(value()?.into())
                        .map_err(|_| "unknown --effort level")?,
                )
            }
            "--sandbox" => {
                request.sandbox = serde_json::from_value::<SandboxLevel>(value()?.into())
                    .map_err(|_| "unknown --sandbox level")?
            }
            flag if flag.starts_with("--") => return Err(format!("unknown option {flag}")),
            _ => prompt.push(arg),
        }
    }
    request.prompt = prompt.join(" ");
    if request.prompt.trim().is_empty() && request.attachments.is_empty() {
        return Err("missing prompt".into());
    }
    if mock {
        request.harness = HarnessId::Mock;
    }
    Ok(Options {
        mock,
        json,
        request,
    })
}

#[tokio::main]
async fn main() {
    let options = match parse_args() {
        Ok(options) => options,
        Err(error) => {
            eprintln!("hive-run: {error}\nusage: hive-run [--mock] [--model id] [--effort level] [--sandbox level] [--cwd dir] [--resume id] [--attach path] [--yes] [--json] <prompt>");
            std::process::exit(2);
        }
    };
    let harness: Box<dyn Harness> = if options.mock {
        Box::new(MockHarness::new())
    } else {
        Box::new(ClaudeHarness::new())
    };
    let mut run = match harness.run(options.request) {
        Ok(run) => run,
        Err(error) => {
            eprintln!("{RED}{error}{RESET}");
            std::process::exit(1);
        }
    };

    let mut stdin = stdin_lines();
    let mut printer = Printer::default();
    loop {
        let event = tokio::select! {
            event = run.events.recv() => event,
            _ = tokio::signal::ctrl_c() => {
                eprintln!("\n{YELLOW}interrupting…{RESET}");
                run.handle.interrupt();
                continue;
            }
        };
        let Some(event) = event else { break };
        if options.json {
            println!("{}", serde_json::to_string(&event).unwrap());
        } else {
            printer.print(&event);
        }
        match event {
            AgentEvent::InputRequested {
                request_id,
                questions,
            } => {
                let answers = ask(&questions, &mut stdin).await;
                run.handle.answer(request_id, answers);
            }
            AgentEvent::Done { .. } => follow_up(&run.handle, &mut stdin).await,
            _ => {}
        }
    }
    println!();
}

/// After a turn: the next prompt, or close on an empty line.
async fn follow_up(handle: &RunHandle, stdin: &mut mpsc::UnboundedReceiver<String>) {
    print!("\n{CYAN}> {RESET}");
    std::io::stdout().flush().ok();
    match stdin.recv().await {
        Some(line) if !line.trim().is_empty() => handle.send(line),
        _ => handle.close(),
    }
}

async fn ask(
    questions: &[UserInputQuestion],
    stdin: &mut mpsc::UnboundedReceiver<String>,
) -> Vec<UserInputAnswer> {
    let mut answers = Vec::new();
    for q in questions {
        println!("\n{CYAN}? [{}] {}{RESET}", q.header, q.question);
        for (i, option) in q.options.iter().enumerate() {
            println!("  {}) {option}", i + 1);
        }
        let hint = if q.multi_select {
            "numbers, comma-separated"
        } else {
            "number"
        };
        print!("{DIM}{hint}, or type an answer:{RESET} ");
        std::io::stdout().flush().ok();
        let line = stdin.recv().await.unwrap_or_default();
        let labels = line
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| match s.parse::<usize>() {
                Ok(n) if (1..=q.options.len()).contains(&n) => q.options[n - 1].clone(),
                _ => s.to_owned(),
            })
            .collect();
        answers.push(UserInputAnswer {
            question_id: q.id.clone(),
            labels,
        });
    }
    answers
}

/// Stdin read on a thread so a pending read never blocks the event loop.
fn stdin_lines() -> mpsc::UnboundedReceiver<String> {
    let (tx, rx) = mpsc::unbounded_channel();
    std::thread::spawn(move || {
        for line in std::io::stdin().lock().lines() {
            let Ok(line) = line else { return };
            if tx.send(line).is_err() {
                return;
            }
        }
    });
    rx
}

#[derive(Default, PartialEq)]
enum Stream {
    #[default]
    None,
    Text,
    Reasoning,
}

#[derive(Default)]
struct Printer {
    /// What the last streamed delta was, so a change of kind starts a line.
    stream: Stream,
}

impl Printer {
    fn print(&mut self, event: &AgentEvent) {
        match event {
            AgentEvent::TextDelta { text } => self.stream(Stream::Text, text, ""),
            AgentEvent::ReasoningDelta { text } => self.stream(Stream::Reasoning, text, DIM),
            other => {
                self.break_stream();
                println!("{}", describe(other));
            }
        }
        std::io::stdout().flush().ok();
    }

    fn stream(&mut self, kind: Stream, text: &str, style: &str) {
        if self.stream != kind {
            self.break_stream();
            if kind == Stream::Reasoning {
                print!("{DIM}thinking: {RESET}");
            }
            self.stream = kind;
        }
        print!("{style}{text}{RESET}");
    }

    fn break_stream(&mut self) {
        if self.stream != Stream::None {
            println!();
            self.stream = Stream::None;
        }
    }
}

fn describe(event: &AgentEvent) -> String {
    match event {
        AgentEvent::SessionStarted {
            model,
            cwd,
            session_id,
            ..
        } => format!("{DIM}● session {session_id} · {model} · {cwd}{RESET}"),
        AgentEvent::TextDelta { text } | AgentEvent::ReasoningDelta { text } => text.clone(),
        AgentEvent::ToolCall { id, call } => {
            format!("{YELLOW}→ {}{RESET} {DIM}{id}{RESET}", tool_summary(call))
        }
        AgentEvent::ToolResult {
            is_error, output, ..
        } => {
            let first = output
                .as_deref()
                .and_then(|o| o.lines().find(|l| !l.trim().is_empty()))
                .unwrap_or("");
            let first: String = first.chars().take(100).collect();
            if *is_error {
                format!("  {RED}✗ {first}{RESET}")
            } else {
                format!("  {GREEN}✓{RESET} {DIM}{first}{RESET}")
            }
        }
        AgentEvent::InputRequested { request_id, .. } => {
            format!("{CYAN}? input requested ({request_id}){RESET}")
        }
        AgentEvent::InputResolved { request_id } => {
            format!("{DIM}  input resolved ({request_id}){RESET}")
        }
        AgentEvent::ContextUsage { tokens, window } => format!(
            "{DIM}  context {} / {}{RESET}",
            tokens.map_or("?".into(), |t| t.to_string()),
            window.map_or("?".into(), |w| w.to_string())
        ),
        AgentEvent::Usage {
            input_tokens,
            output_tokens,
        } => format!("{DIM}  usage {input_tokens} in · {output_tokens} out{RESET}"),
        AgentEvent::AvailableCommands { commands } => {
            let skills = commands
                .iter()
                .filter(|c| c.kind == hive_proto::CommandKind::Skill)
                .count();
            format!(
                "{DIM}● {} slash commands, {skills} skills{RESET}",
                commands.len() - skills
            )
        }
        AgentEvent::Error { message } => format!("{RED}! {message}{RESET}"),
        AgentEvent::Subagent {
            parent_tool_id,
            event,
        } => format!(
            "{DIM}  ↳ [{parent_tool_id}]{RESET} {}",
            describe(event).trim()
        ),
        AgentEvent::Done {
            status,
            error,
            session_id,
        } => {
            let status = serde_json::to_value(status).unwrap();
            let mut line = format!(
                "{CYAN}■ done: {}{RESET}",
                status.as_str().unwrap_or_default()
            );
            if let Some(session_id) = session_id {
                line.push_str(&format!(" {DIM}(session {session_id}){RESET}"));
            }
            if let Some(error) = error {
                line.push_str(&format!("\n{RED}{error}{RESET}"));
            }
            line
        }
    }
}

fn tool_summary(call: &ToolCall) -> String {
    match call {
        ToolCall::Exec { command } => format!("run {command}"),
        ToolCall::ReadFile { path } => format!("read {path}"),
        ToolCall::WriteFile { path, .. } => format!("write {path}"),
        ToolCall::EditFile { path, .. } => format!("edit {path}"),
        ToolCall::ApplyPatch { path } => format!("patch {}", path.as_deref().unwrap_or("")),
        ToolCall::Search { pattern, path } => match path {
            Some(path) => format!("search {pattern} in {path}"),
            None => format!("search {pattern}"),
        },
        ToolCall::Glob { pattern } => format!("glob {pattern}"),
        ToolCall::WebFetch { url, .. } => format!("fetch {url}"),
        ToolCall::WebSearch { query } => format!("web search {query}"),
        ToolCall::Todo { items } => {
            let list: Vec<String> = items
                .iter()
                .map(|item| {
                    let mark = match item.status {
                        hive_proto::TodoStatus::Completed => "x",
                        hive_proto::TodoStatus::InProgress => "~",
                        hive_proto::TodoStatus::Pending => " ",
                    };
                    format!("[{mark}] {}", item.text)
                })
                .collect();
            format!("todos {}", list.join("  "))
        }
        ToolCall::Subagent { description, model } => match model {
            Some(model) => format!("agent ({model}) {description}"),
            None => format!("agent {description}"),
        },
        ToolCall::Mcp { server, tool, .. } => format!("mcp {server}/{tool}"),
        ToolCall::Unknown { name, .. } => name.clone(),
    }
}
