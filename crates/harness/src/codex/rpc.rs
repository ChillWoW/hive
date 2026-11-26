//! A JSON-RPC connection to a `codex app-server` child: one JSON object per
//! line each way, without the `"jsonrpc"` field. Our requests get numeric
//! ids; the server's own requests (approvals, questions) arrive with its ids
//! and are answered with [`Client::respond`].

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

/// How long the server gets to answer `initialize`.
const INITIALIZE_TIMEOUT: Duration = Duration::from_secs(20);
/// Tries at starting a server before giving up.
const START_ATTEMPTS: u64 = 3;

/// Held while a server starts; see [`Server::start`].
static STARTING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

pub(super) const SERVER_GONE: &str = "codex app-server exited";

/// Something the server sent that isn't an answer to us.
#[derive(Debug, Clone, PartialEq)]
pub(super) enum Incoming {
    Notification { method: String, params: Value },
    /// Waits for [`Client::respond`] under `id`.
    Request { id: Value, method: String, params: Value },
}

type Waiters = Arc<Mutex<HashMap<i64, oneshot::Sender<Result<Value, String>>>>>;

/// The writing half; cheap to clone. Requests resolve when the reader sees
/// their answer, or fail once the server is gone.
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
        let sent = self
            .lines
            .send(json!({ "id": id, "method": method, "params": params }).to_string());
        if sent.is_err() {
            self.waiters.lock().unwrap().remove(&id);
        }
        async move { rx.await.unwrap_or_else(|_| Err(SERVER_GONE.into())) }
    }

    /// Sends `method` and forgets the answer.
    pub(super) fn fire(&self, method: &str, params: Value) {
        tokio::spawn(self.request(method, params));
    }

    pub(super) fn notify(&self, method: &str) {
        let _ = self.lines.send(json!({ "method": method }).to_string());
    }

    pub(super) fn respond(&self, id: &Value, result: Value) {
        let _ = self.lines.send(json!({ "id": id, "result": result }).to_string());
    }

    pub(super) fn respond_error(&self, id: &Value, message: &str) {
        let _ = self
            .lines
            .send(json!({ "id": id, "error": { "code": -32601, "message": message } }).to_string());
    }
}

/// A running app-server. Dropping every [`Client`] closes its stdin, which
/// ends it.
pub(super) struct Server {
    pub child: Child,
    pub client: Client,
    pub incoming: mpsc::Receiver<Incoming>,
    pub stderr: StderrTail,
}

impl Server {
    /// Starts `codex app-server` in `cwd` and completes the `initialize`
    /// handshake (with the experimental API, for plan mode).
    ///
    /// ⚠ Servers starting at the same moment race to open the CLI's SQLite
    /// state under `$CODEX_HOME`, and the loser exits: so they start one at a
    /// time, and one that exits before it's up is tried again.
    pub(super) async fn start(exe: &Path, cwd: Option<&Path>) -> Result<Self, HarnessError> {
        let _turn = STARTING.lock().await;
        let mut attempt = 0;
        loop {
            attempt += 1;
            match Self::start_once(exe, cwd).await {
                Err(HarnessError::Probe(_)) if attempt < START_ATTEMPTS => {
                    tokio::time::sleep(Duration::from_millis(250 * attempt)).await;
                }
                result => return result,
            }
        }
    }

    async fn start_once(exe: &Path, cwd: Option<&Path>) -> Result<Self, HarnessError> {
        let mut cmd = cli::command(exe);
        cmd.arg("app-server")
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
        tokio::spawn(read_stdout(stdout, Arc::clone(&waiters), incoming_tx));

        let client = Client {
            lines,
            waiters,
            next_id: Arc::new(AtomicI64::new(0)),
        };
        let init = client.request(
            "initialize",
            json!({
                "clientInfo": { "name": "outcode", "title": "Outcode", "version": env!("CARGO_PKG_VERSION") },
                "capabilities": { "experimentalApi": true, "requestAttestation": false },
            }),
        );
        let failed = |message: String| HarnessError::Probe(stderr.under(message));
        let outcome = match tokio::time::timeout(INITIALIZE_TIMEOUT, init).await {
            Ok(Ok(_)) => Ok(()),
            Ok(Err(e)) => Err(failed(format!("codex app-server didn't start: {e}"))),
            Err(_) => Err(failed("codex app-server didn't answer".into())),
        };
        if let Err(error) = outcome {
            drop(client);
            cli::kill_tree(&mut child).await;
            return Err(error);
        }
        client.notify("initialized");
        Ok(Self {
            child,
            client,
            incoming,
            stderr,
        })
    }

    /// Asks one thing of a server started just for it, then stops it.
    pub(super) async fn one_shot(
        exe: &Path,
        cwd: Option<&Path>,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, String> {
        let server = tokio::time::timeout(timeout, Self::start(exe, cwd))
            .await
            .map_err(|_| "codex app-server didn't start".to_owned())?
            .map_err(|e| e.to_string())?;
        let Self {
            client,
            incoming,
            mut child,
            ..
        } = server;
        drop(incoming);
        let answer = tokio::time::timeout(timeout, client.request(method, params))
            .await
            .unwrap_or_else(|_| Err(format!("codex didn't answer {method}")));
        drop(client);
        tokio::spawn(async move { retire(&mut child).await });
        answer
    }
}

/// `OUTCODE_CODEX_TRACE` set: every line each way goes to stderr.
fn tracing() -> bool {
    std::env::var_os("OUTCODE_CODEX_TRACE").is_some()
}

/// Passes `lines` on, printing each.
fn traced(mut lines: mpsc::UnboundedReceiver<String>) -> mpsc::UnboundedReceiver<String> {
    let (tx, rx) = mpsc::unbounded_channel();
    tokio::spawn(async move {
        while let Some(line) = lines.recv().await {
            eprintln!("[codex] -> {line}");
            if tx.send(line).is_err() {
                return;
            }
        }
    });
    rx
}

/// Waits [`cli::EXIT_GRACE`] for a server whose stdin closed to exit, then
/// stops its tree (⚠ an npm shim's `cmd` → `node` → `codex`).
pub(super) async fn retire(child: &mut Child) -> Option<std::process::ExitStatus> {
    if let Ok(status) = tokio::time::timeout(cli::EXIT_GRACE, child.wait()).await {
        return status.ok();
    }
    cli::kill_tree(child).await;
    None
}

async fn read_stdout(stdout: ChildStdout, waiters: Waiters, incoming: mpsc::Sender<Incoming>) {
    let mut lines = BufReader::new(stdout).lines();
    let trace = tracing();
    while let Ok(Some(line)) = lines.next_line().await {
        if trace {
            eprintln!("[codex] <- {line}");
        }
        match parse_line(&line) {
            Some(Parsed::Incoming(event)) => {
                // A dropped receiver (a one-shot server) only stops the
                // forwarding; answers still need reading.
                let _ = incoming.send(event).await;
            }
            Some(Parsed::Answer(id, result)) => {
                if let Some(waiter) = waiters.lock().unwrap().remove(&id) {
                    let _ = waiter.send(result);
                }
            }
            None => {}
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

/// One line from the server; `None` for stray output and answers we can't
/// place.
fn parse_line(line: &str) -> Option<Parsed> {
    let mut msg: Value = serde_json::from_str(line.trim()).ok()?;
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
            parse_line(r#"{"id":3,"result":{"ok":true}}"#),
            Some(Parsed::Answer(3, Ok(json!({"ok": true}))))
        );
        assert_eq!(
            parse_line(r#"{"id":4,"error":{"code":-1,"message":"nope"}}"#),
            Some(Parsed::Answer(4, Err("nope".into())))
        );
        assert_eq!(
            parse_line(r#"{"id":"s1","method":"item/tool/requestUserInput","params":{"q":1}}"#),
            Some(Parsed::Incoming(Incoming::Request {
                id: json!("s1"),
                method: "item/tool/requestUserInput".into(),
                params: json!({"q": 1}),
            }))
        );
        assert_eq!(
            parse_line(r#"{"method":"turn/started","params":{}}"#),
            Some(Parsed::Incoming(Incoming::Notification {
                method: "turn/started".into(),
                params: json!({}),
            }))
        );
        assert_eq!(parse_line("WARN something"), None);
    }
}
