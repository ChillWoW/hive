//! A JSON-RPC connection to a `codex app-server` child: one JSON object per
//! line each way, without the `"jsonrpc"` field. Our requests get numeric
//! ids; the server's own requests (approvals, questions) arrive with its ids
//! and are answered with [`Client::respond`].

use std::collections::HashMap;
use std::path::Path;
use std::process::Stdio;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Child;
use tokio::sync::{mpsc, oneshot};

use crate::claude::{collect_stderr, command_for, write_stdin};
use crate::HarnessError;

/// How long the server gets to answer `initialize`.
const INITIALIZE_TIMEOUT: Duration = Duration::from_secs(20);
/// Tries at starting a server before giving up.
const START_ATTEMPTS: u64 = 3;

/// Held while a server starts; see [`Server::start`].
static STARTING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Something the server sent that isn't an answer to us.
#[derive(Debug, Clone)]
pub enum Incoming {
    Notification {
        method: String,
        params: Value,
    },
    /// Waits for [`Client::respond`] under `id`.
    Request {
        id: Value,
        method: String,
        params: Value,
    },
}

type Waiters = Arc<Mutex<HashMap<i64, oneshot::Sender<Result<Value, String>>>>>;

/// The writing half; cheap to clone. Requests resolve when the reader sees
/// their answer, or fail once the server is gone.
#[derive(Clone)]
pub struct Client {
    lines: mpsc::UnboundedSender<String>,
    waiters: Waiters,
    next_id: Arc<AtomicI64>,
}

impl Client {
    pub fn request(
        &self,
        method: &str,
        params: Value,
    ) -> impl std::future::Future<Output = Result<Value, String>> + Send + 'static {
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

    pub fn notify(&self, method: &str) {
        let _ = self.lines.send(json!({ "method": method }).to_string());
    }

    pub fn respond(&self, id: &Value, result: Value) {
        let _ = self
            .lines
            .send(json!({ "id": id, "result": result }).to_string());
    }

    pub fn respond_error(&self, id: &Value, message: &str) {
        let _ = self
            .lines
            .send(json!({ "id": id, "error": { "code": -32601, "message": message } }).to_string());
    }
}

pub const SERVER_GONE: &str = "codex app-server exited";

/// A running app-server. Dropping it (and every [`Client`]) closes stdin,
/// which ends the server; `kill_on_drop` covers the rest.
pub struct Server {
    pub child: Child,
    pub client: Client,
    pub incoming: mpsc::Receiver<Incoming>,
    pub stderr_tail: Arc<Mutex<String>>,
}

impl Server {
    /// Starts `codex app-server` in `cwd` and completes the `initialize`
    /// handshake (with the experimental API, for plan mode).
    ///
    /// Servers starting at the same moment race to open the CLI's SQLite
    /// state under `$CODEX_HOME`, and the loser exits; so Hive starts one at a
    /// time, and tries again when one exits before it's up.
    pub async fn start(exe: &Path, cwd: &str) -> Result<Self, HarnessError> {
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

    async fn start_once(exe: &Path, cwd: &str) -> Result<Self, HarnessError> {
        let mut cmd = command_for(exe);
        cmd.arg("app-server")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        if !cwd.is_empty() {
            cmd.current_dir(cwd);
        }
        #[cfg(windows)]
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        let mut child = cmd.spawn().map_err(|e| HarnessError::Spawn("codex", e))?;
        let stdin = child.stdin.take().expect("piped stdin");
        let stdout = child.stdout.take().expect("piped stdout");
        let stderr = child.stderr.take().expect("piped stderr");

        let stderr_tail = Arc::new(Mutex::new(String::new()));
        tokio::spawn(collect_stderr(stderr, Arc::clone(&stderr_tail)));
        let (lines, lines_rx) = mpsc::unbounded_channel();
        tokio::spawn(write_stdin(stdin, lines_rx));

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
                "clientInfo": { "name": "hive", "title": "Hive", "version": env!("CARGO_PKG_VERSION") },
                "capabilities": { "experimentalApi": true },
            }),
        );
        let failed = |message: String| {
            let stderr = stderr_tail.lock().unwrap().trim().to_owned();
            HarnessError::Probe(if stderr.is_empty() {
                message
            } else {
                format!("{message}\n{stderr}")
            })
        };
        match tokio::time::timeout(INITIALIZE_TIMEOUT, init).await {
            Ok(Ok(_)) => {}
            Ok(Err(e)) => return Err(failed(format!("codex app-server didn't start: {e}"))),
            Err(_) => return Err(failed("codex app-server didn't answer".into())),
        }
        client.notify("initialized");
        Ok(Self {
            child,
            client,
            incoming,
            stderr_tail,
        })
    }

    /// Asks one thing of a server started just for it, then stops it.
    pub async fn one_shot(
        exe: &Path,
        cwd: &str,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, String> {
        let work = async {
            let Self {
                client,
                incoming,
                child: _child,
                ..
            } = Self::start(exe, cwd).await.map_err(|e| e.to_string())?;
            drop(incoming);
            client.request(method, params).await
        };
        tokio::time::timeout(timeout, work)
            .await
            .map_err(|_| format!("codex didn't answer {method}"))?
    }
}

async fn read_stdout(
    stdout: tokio::process::ChildStdout,
    waiters: Waiters,
    incoming: mpsc::Sender<Incoming>,
) {
    let mut lines = BufReader::new(stdout).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let Ok(mut msg) = serde_json::from_str::<Value>(line.trim()) else {
            continue; // Not JSON: stray output.
        };
        let method = msg.get("method").and_then(Value::as_str).map(str::to_owned);
        let id = msg.get("id").cloned().filter(|id| !id.is_null());
        let params = msg
            .get_mut("params")
            .map(Value::take)
            .unwrap_or(Value::Null);
        let event = match (method, id) {
            (Some(method), Some(id)) => Incoming::Request { id, method, params },
            (Some(method), None) => Incoming::Notification { method, params },
            (None, Some(id)) => {
                let Some(waiter) = id
                    .as_i64()
                    .and_then(|id| waiters.lock().unwrap().remove(&id))
                else {
                    continue;
                };
                let result = match msg.get_mut("error") {
                    Some(error) => Err(error
                        .get("message")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                        .unwrap_or_else(|| error.to_string())),
                    None => Ok(msg
                        .get_mut("result")
                        .map(Value::take)
                        .unwrap_or(Value::Null)),
                };
                let _ = waiter.send(result);
                continue;
            }
            (None, None) => continue,
        };
        // A dropped receiver (a one-shot server) only stops the forwarding;
        // answers still need reading.
        let _ = incoming.send(event).await;
    }
    // Fail whatever is still waiting.
    waiters.lock().unwrap().clear();
}
