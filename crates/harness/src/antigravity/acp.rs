//! A JSON-RPC 2.0 connection to an `agy acp` child: the Agent Client
//! Protocol, one JSON object per line each way. Our requests get numeric ids;
//! the agent's own requests (permissions) arrive with its ids and are
//! answered with [`Client::respond`]. Lines that aren't JSON (a sign-in link)
//! go to [`Server::other`].

use std::collections::HashMap;
use std::future::Future;
use std::path::Path;
use std::process::Stdio;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, ChildStdout};
use tokio::sync::{mpsc, oneshot};

use super::NAME;
use crate::HarnessError;
use crate::cli::{self, StderrTail};

/// How long the agent gets to answer `initialize`.
const INITIALIZE_TIMEOUT: Duration = Duration::from_secs(30);

pub(super) const SERVER_GONE: &str = "agy acp exited";

/// Something the agent sent that isn't an answer to us.
#[derive(Debug, Clone, PartialEq)]
pub(super) enum Incoming {
    Notification { method: String, params: Value },
    /// Waits for [`Client::respond`] under `id`.
    Request { id: Value, method: String, params: Value },
}

type Waiters = Arc<Mutex<HashMap<i64, oneshot::Sender<Result<Value, String>>>>>;

/// The writing half; cheap to clone. Requests resolve when the reader sees
/// their answer, or fail once the agent is gone.
#[derive(Clone)]
pub(super) struct Client {
    lines: mpsc::UnboundedSender<String>,
    waiters: Waiters,
    next_id: Arc<AtomicI64>,
}

impl Client {
    pub(super) fn request(&self, method: &str, params: Value) -> impl Future<Output = Result<Value, String>> + Send + 'static {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.waiters.lock().unwrap().insert(id, tx);
        let line = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        if self.lines.send(line.to_string()).is_err() {
            self.waiters.lock().unwrap().remove(&id);
        }
        async move { rx.await.unwrap_or_else(|_| Err(SERVER_GONE.into())) }
    }

    pub(super) fn notify(&self, method: &str, params: Value) {
        let line = json!({ "jsonrpc": "2.0", "method": method, "params": params });
        let _ = self.lines.send(line.to_string());
    }

    pub(super) fn respond(&self, id: &Value, result: Value) {
        let _ = self
            .lines
            .send(json!({ "jsonrpc": "2.0", "id": id, "result": result }).to_string());
    }

    pub(super) fn respond_error(&self, id: &Value, message: &str) {
        let line = json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": message } });
        let _ = self.lines.send(line.to_string());
    }
}

/// A running `agy acp`. Dropping every [`Client`] closes its stdin, which
/// ends it.
pub(super) struct Server {
    pub child: Child,
    pub client: Client,
    pub incoming: mpsc::Receiver<Incoming>,
    /// Lines on stdout that aren't JSON-RPC.
    pub other: mpsc::UnboundedReceiver<String>,
    pub stderr: StderrTail,
    /// `initialize`'s answer: the agent's capabilities and version.
    pub info: Value,
}

impl Server {
    /// Starts `agy acp` in `cwd` and completes the `initialize` handshake.
    pub(super) async fn start(exe: &Path, cwd: Option<&Path>) -> Result<Self, HarnessError> {
        let mut cmd = cli::command(exe);
        cmd.arg("acp")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(cwd) = cwd {
            cmd.current_dir(cwd);
        }
        let mut child = cmd.spawn().map_err(|e| HarnessError::Spawn(NAME, e))?;
        let stdin = child.stdin.take().expect("piped stdin");
        let stdout = child.stdout.take().expect("piped stdout");
        let stderr = StderrTail::collect(child.stderr.take().expect("piped stderr"));
        let (lines, lines_rx) = mpsc::unbounded_channel::<String>();
        let lines_rx = if tracing() { traced(lines_rx) } else { lines_rx };
        tokio::spawn(cli::write_stdin(stdin, lines_rx));

        let waiters: Waiters = Arc::default();
        let (incoming_tx, incoming) = mpsc::channel(512);
        let (other_tx, other) = mpsc::unbounded_channel();
        tokio::spawn(read_stdout(stdout, Arc::clone(&waiters), incoming_tx, other_tx));

        let client = Client {
            lines,
            waiters,
            next_id: Arc::new(AtomicI64::new(0)),
        };
        let init = client.request(
            "initialize",
            json!({
                "protocolVersion": 1,
                // The agent reads and writes files itself, and runs its own
                // terminal.
                "clientCapabilities": {
                    "fs": { "readTextFile": false, "writeTextFile": false },
                    "terminal": false,
                },
                "clientInfo": { "name": "outcode", "title": "Outcode", "version": env!("CARGO_PKG_VERSION") },
            }),
        );
        let failed = |message: String| HarnessError::Probe(stderr.under(message));
        let outcome = match tokio::time::timeout(INITIALIZE_TIMEOUT, init).await {
            Ok(Ok(info)) => Ok(info),
            Ok(Err(e)) => Err(failed(format!("agy acp didn't start: {e}"))),
            Err(_) => Err(failed("agy acp didn't answer".into())),
        };
        let info = match outcome {
            Ok(info) => info,
            Err(error) => {
                drop(client);
                cli::kill_tree(&mut child).await;
                return Err(error);
            }
        };
        Ok(Self {
            child,
            client,
            incoming,
            other,
            stderr,
            info,
        })
    }
}

/// `OUTCODE_AGY_TRACE` set: every line each way goes to stderr.
fn tracing() -> bool {
    std::env::var_os("OUTCODE_AGY_TRACE").is_some()
}

/// Passes `lines` on, printing each.
fn traced(mut lines: mpsc::UnboundedReceiver<String>) -> mpsc::UnboundedReceiver<String> {
    let (tx, rx) = mpsc::unbounded_channel();
    tokio::spawn(async move {
        while let Some(line) = lines.recv().await {
            eprintln!("[agy] -> {line}");
            if tx.send(line).is_err() {
                return;
            }
        }
    });
    rx
}

/// Waits [`cli::EXIT_GRACE`] for an agent whose stdin closed to exit, then
/// stops its tree.
pub(super) async fn retire(child: &mut Child) -> Option<std::process::ExitStatus> {
    if let Ok(status) = tokio::time::timeout(cli::EXIT_GRACE, child.wait()).await {
        return status.ok();
    }
    cli::kill_tree(child).await;
    None
}

async fn read_stdout(
    stdout: ChildStdout,
    waiters: Waiters,
    incoming: mpsc::Sender<Incoming>,
    other: mpsc::UnboundedSender<String>,
) {
    let mut lines = BufReader::new(stdout).lines();
    let trace = tracing();
    while let Ok(Some(line)) = lines.next_line().await {
        if trace {
            eprintln!("[agy] <- {line}");
        }
        match parse_line(&line) {
            Some(Parsed::Incoming(event)) => {
                let _ = incoming.send(event).await;
            }
            Some(Parsed::Answer(id, result)) => {
                if let Some(waiter) = waiters.lock().unwrap().remove(&id) {
                    let _ = waiter.send(result);
                }
            }
            None => {
                let _ = other.send(line);
            }
        }
    }
    // Fail whatever is still waiting.
    waiters.lock().unwrap().clear();
}

#[derive(Debug, PartialEq)]
enum Parsed {
    Incoming(Incoming),
    Answer(i64, Result<Value, String>),
}

/// One line from the agent; `None` for stray output.
fn parse_line(line: &str) -> Option<Parsed> {
    let mut msg: Value = serde_json::from_str(line.trim()).ok()?;
    if !msg.is_object() {
        return None;
    }
    let method = msg.get("method").and_then(Value::as_str).map(str::to_owned);
    let id = msg.get("id").cloned().filter(|id| !id.is_null());
    let params = msg.get_mut("params").map(Value::take).unwrap_or(Value::Null);
    match (method, id) {
        (Some(method), Some(id)) => Some(Parsed::Incoming(Incoming::Request { id, method, params })),
        (Some(method), None) => Some(Parsed::Incoming(Incoming::Notification { method, params })),
        (None, Some(id)) => {
            let id = id.as_i64()?;
            let result = match msg.get_mut("error") {
                Some(error) => Err(error
                    .get("message")
                    .and_then(Value::as_str)
                    .map_or_else(|| error.to_string(), str::to_owned)),
                None => Ok(msg.get_mut("result").map(Value::take).unwrap_or(Value::Null)),
            };
            Some(Parsed::Answer(id, result))
        }
        (None, None) => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lines_sort_into_answers_requests_and_notifications() {
        assert_eq!(
            parse_line(r#"{"jsonrpc":"2.0","result":{"stopReason":"end_turn"},"id":5}"#),
            Some(Parsed::Answer(5, Ok(json!({"stopReason": "end_turn"}))))
        );
        assert_eq!(
            parse_line(r#"{"jsonrpc":"2.0","id":2,"error":{"code":-32002,"message":"no session"}}"#),
            Some(Parsed::Answer(2, Err("no session".into())))
        );
        assert_eq!(
            parse_line(r#"{"jsonrpc":"2.0","method":"session/request_permission","params":{"a":1},"id":"1"}"#),
            Some(Parsed::Incoming(Incoming::Request {
                id: json!("1"),
                method: "session/request_permission".into(),
                params: json!({"a": 1}),
            }))
        );
        assert_eq!(
            parse_line(r#"{"jsonrpc":"2.0","method":"session/update","params":{}}"#),
            Some(Parsed::Incoming(Incoming::Notification {
                method: "session/update".into(),
                params: json!({}),
            }))
        );
        assert_eq!(parse_line("Open the following link to authenticate the ACP server: https://x"), None);
        assert_eq!(parse_line("42"), None);
    }
}
