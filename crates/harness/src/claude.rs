//! Claude Code: spawns the installed `claude` CLI and speaks its stream-json
//! protocol over stdin/stdout.
//!
//! One prompt per process for now: the prompt goes in as a user line, text
//! deltas come back as [`AgentEvent::TextDelta`], and the CLI's `result`
//! frame ends the turn, after which stdin closes and the process exits.

use std::path::{Path, PathBuf};
use std::process::Stdio;

use outcode_proto::{AgentEvent, RunRequest};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::mpsc;

use crate::cli::{self, StderrTail};
use crate::{HarnessError, Run};

const NAME: &str = "claude";

/// The `claude` binary: `binary` when given, else on PATH or where its
/// installers put it.
pub fn find(binary: Option<&Path>) -> Result<PathBuf, HarnessError> {
    if let Some(binary) = binary {
        return if binary.is_file() {
            Ok(binary.to_owned())
        } else {
            Err(HarnessError::BinaryMissing(binary.display().to_string()))
        };
    }
    let home = cli::home_dir();
    let mut paths = Vec::new();
    if cfg!(windows) {
        if let Some(home) = &home {
            paths.push(home.join(r".local\bin\claude.exe"));
        }
        if let Some(appdata) = std::env::var_os("APPDATA") {
            paths.push(PathBuf::from(appdata).join(r"npm\claude.cmd"));
        }
    } else {
        if let Some(home) = &home {
            paths.push(home.join(".local/bin/claude"));
            paths.push(home.join(".claude/local/claude"));
        }
        paths.push("/opt/homebrew/bin/claude".into());
        paths.push("/usr/local/bin/claude".into());
    }
    cli::find(NAME, paths).ok_or(HarnessError::NotInstalled(NAME))
}

/// Without an approval UI yet, tool calls that would ask are refused by the
/// CLI itself (`--print` has no one to ask).
const ARGS: [&str; 7] = [
    "--print",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    // Required alongside `--print --output-format stream-json`.
    "--verbose",
    "--include-partial-messages",
];

/// Starts `claude` (`binary`, or the one [`find`] finds) on `request.prompt`.
/// Must be called from inside a tokio runtime.
pub fn run(request: RunRequest, binary: Option<&Path>) -> Result<Run, HarnessError> {
    let exe = find(binary)?;
    let mut cmd = cli::command(&exe);
    cmd.args(ARGS)
        // Set when Outcode itself runs inside Claude Code; the child would
        // otherwise think it's nested.
        .env_remove("CLAUDECODE")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let cwd = match request.cwd.trim() {
        "" => cli::home_dir(),
        cwd => Some(PathBuf::from(cwd)),
    };
    if let Some(cwd) = cwd {
        cmd.current_dir(cwd);
    }
    let mut child = cmd.spawn().map_err(|e| HarnessError::Spawn(NAME, e))?;
    let stdin = child.stdin.take().expect("piped stdin");
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = StderrTail::collect(child.stderr.take().expect("piped stderr"));

    let (stdin_tx, stdin_rx) = mpsc::unbounded_channel::<String>();
    tokio::spawn(cli::write_stdin(stdin, stdin_rx));
    let _ = stdin_tx.send(user_line(&request.prompt));

    let (events_tx, events) = mpsc::channel(256);
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        let mut normalizer = Normalizer::default();
        let mut finished = false;
        while let Ok(Some(line)) = lines.next_line().await {
            let Ok(frame) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            let (out, done) = normalizer.frame(&frame);
            let mut gone = false;
            for event in out {
                gone |= events_tx.send(event).await.is_err();
            }
            if done || gone {
                finished = done;
                break;
            }
        }
        // Closing stdin ends the session; the CLI exits on its own.
        drop(stdin_tx);
        let status = cli::wait_or_kill(&mut child).await;
        if !finished {
            let message = stderr.under(format!(
                "Claude exited before finishing the turn (exit code {}).",
                cli::exit_code(status)
            ));
            let _ = events_tx.send(AgentEvent::Error { message }).await;
        }
        let _ = events_tx.send(AgentEvent::Done).await;
    });
    Ok(Run { events })
}

/// A user turn on stdin.
fn user_line(text: &str) -> String {
    json!({
        "type": "user",
        "message": { "role": "user", "content": text },
        "parent_tool_use_id": null,
    })
    .to_string()
}

/// Turns stdout frames into events.
#[derive(Default)]
struct Normalizer {
    /// Text was streamed this turn: a later text block starts a new paragraph.
    wrote_text: bool,
}

impl Normalizer {
    /// The events `frame` makes, and whether it ended the turn. `Done` itself
    /// is the caller's, once the process is gone.
    fn frame(&mut self, frame: &Value) -> (Vec<AgentEvent>, bool) {
        let str_at = |pointer: &str| frame.pointer(pointer).and_then(Value::as_str);
        match str_at("/type") {
            // Subagents' traffic carries the spawning tool call's id.
            Some("stream_event") if !frame["parent_tool_use_id"].is_string() => {
                match str_at("/event/type") {
                    Some("content_block_start")
                        if str_at("/event/content_block/type") == Some("text")
                            && self.wrote_text =>
                    {
                        (vec![text("\n\n")], false)
                    }
                    Some("content_block_delta")
                        if str_at("/event/delta/type") == Some("text_delta") =>
                    {
                        match str_at("/event/delta/text") {
                            Some(delta) if !delta.is_empty() => {
                                self.wrote_text = true;
                                (vec![text(delta)], false)
                            }
                            _ => (Vec::new(), false),
                        }
                    }
                    _ => (Vec::new(), false),
                }
            }
            Some("result") => {
                let failed = frame["is_error"].as_bool().unwrap_or(false)
                    || str_at("/subtype").is_some_and(|s| s != "success");
                let events = if failed {
                    vec![AgentEvent::Error {
                        message: result_error(frame),
                    }]
                } else {
                    Vec::new()
                };
                (events, true)
            }
            _ => (Vec::new(), false),
        }
    }
}

fn text(text: &str) -> AgentEvent {
    AgentEvent::TextDelta { text: text.into() }
}

/// What a failed `result` says went wrong.
fn result_error(frame: &Value) -> String {
    if let Some(result) = frame["result"].as_str().filter(|r| !r.trim().is_empty()) {
        return result.trim().to_owned();
    }
    let errors: Vec<String> = frame["errors"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|e| e.as_str().map_or_else(|| e.to_string(), str::to_owned))
        .collect();
    if !errors.is_empty() {
        return errors.join("\n");
    }
    match frame["subtype"].as_str() {
        Some(subtype) => format!("Claude's turn failed ({subtype})."),
        None => "Claude's turn failed.".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn feed(frames: &[Value]) -> (Vec<AgentEvent>, bool) {
        let mut normalizer = Normalizer::default();
        let mut events = Vec::new();
        for frame in frames {
            let (out, done) = normalizer.frame(frame);
            events.extend(out);
            if done {
                return (events, true);
            }
        }
        (events, false)
    }

    fn delta(text: &str) -> Value {
        json!({
            "type": "stream_event",
            "parent_tool_use_id": null,
            "event": { "type": "content_block_delta", "index": 0,
                       "delta": { "type": "text_delta", "text": text } },
        })
    }

    fn text_start() -> Value {
        json!({
            "type": "stream_event",
            "event": { "type": "content_block_start", "content_block": { "type": "text", "text": "" } },
        })
    }

    #[test]
    fn text_deltas_then_result() {
        let (events, done) = feed(&[
            json!({ "type": "system", "subtype": "init" }),
            text_start(),
            delta("Hel"),
            delta("lo"),
            json!({ "type": "assistant", "message": { "content": [] } }),
            json!({ "type": "result", "subtype": "success", "is_error": false, "result": "Hello" }),
        ]);
        assert!(done);
        assert_eq!(events, vec![text("Hel"), text("lo")]);
    }

    #[test]
    fn later_text_blocks_start_a_paragraph() {
        let (events, _) = feed(&[text_start(), delta("a"), text_start(), delta("b")]);
        assert_eq!(events, vec![text("a"), text("\n\n"), text("b")]);
    }

    #[test]
    fn subagent_text_is_skipped() {
        let mut frame = delta("inner");
        frame["parent_tool_use_id"] = "toolu_1".into();
        assert_eq!(feed(&[frame]).0, vec![]);
    }

    #[test]
    fn failed_result_is_an_error() {
        let (events, done) = feed(&[json!({
            "type": "result", "subtype": "success", "is_error": true,
            "result": "Invalid API key · Please run /login",
        })]);
        assert!(done);
        assert_eq!(
            events,
            vec![AgentEvent::Error {
                message: "Invalid API key · Please run /login".into()
            }]
        );
        let (events, _) = feed(&[json!({
            "type": "result", "subtype": "error_during_execution", "errors": ["boom"],
        })]);
        assert_eq!(events, vec![AgentEvent::Error { message: "boom".into() }]);
    }
}
