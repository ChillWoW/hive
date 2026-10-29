//! One `opencode serve` process: spawning it on a free loopback port with a
//! per-run password, the HTTP calls Hive makes to it, and its event bus.
//!
//! The installed `opencode` is often a launcher (bun's shim on Windows) that
//! starts the real server as a child, which in turn starts MCP servers and
//! shells. Stopping only the launcher leaves the rest running, so the whole
//! tree is taken down ([`kill_tree`]).

use std::path::Path;
use std::process::{ExitStatus, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::Value;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Child;
use tokio::sync::mpsc;

use crate::claude::{collect_stderr, command_for};

/// How long the server may take to answer its first health check. Plugins
/// and MCP config load first; a cold start can be slow.
const STARTUP_TIMEOUT: Duration = Duration::from_secs(120);
const HEALTH_POLL: Duration = Duration::from_millis(150);
/// Bound on ordinary calls; everything is loopback.
const CALL_TIMEOUT: Duration = Duration::from_secs(60);
/// Launch attempts: a port taken between our check and the server's bind, or
/// the shared database locked by another server starting, fails a start.
const SPAWN_ATTEMPTS: u32 = 3;

/// Reconnects after the bus drops, with the server still alive.
const BUS_RECONNECTS: u32 = 20;
const BUS_RECONNECT_DELAY: Duration = Duration::from_millis(250);
/// The bus sends a heartbeat every 15s; past this it's presumed wedged.
const BUS_SILENCE: Duration = Duration::from_secs(45);

pub(super) struct Server {
    child: Child,
    pub api: Api,
    stderr_tail: Arc<Mutex<String>>,
    pub version: String,
}

/// The HTTP side of a server, cheap to clone into tasks.
#[derive(Clone)]
pub(super) struct Api {
    base: String,
    auth: String,
    client: reqwest::Client,
    /// The folder calls are scoped to (`x-opencode-directory`).
    directory: Option<String>,
}

/// What the bus delivers.
#[derive(Debug)]
pub(super) enum Bus {
    /// One event: `{ id, type, data }`.
    Frame(Value),
    /// The bus can't be reached any more; frames may have been missed.
    Lost(String),
}

impl Server {
    /// Starts `opencode serve` in `cwd` (home when empty) and waits until it
    /// answers. Only the 2.x API is spoken.
    pub async fn start(exe: &Path, cwd: &str) -> Result<Self, String> {
        let mut last = String::new();
        for attempt in 0..SPAWN_ATTEMPTS {
            if attempt > 0 {
                tokio::time::sleep(Duration::from_millis(250 * u64::from(attempt))).await;
            }
            match Self::start_once(exe, cwd).await {
                Ok(server) => return Ok(server),
                Err((message, retry)) => {
                    last = message;
                    if !retry {
                        break;
                    }
                }
            }
        }
        Err(last)
    }

    async fn start_once(exe: &Path, cwd: &str) -> Result<Self, (String, bool)> {
        let port = free_port().ok_or(("No free local port for OpenCode.".to_owned(), false))?;
        let password = secret();
        let mut cmd = command_for(exe);
        cmd.arg("serve")
            .arg("--port")
            .arg(port.to_string())
            .arg("--hostname")
            .arg("127.0.0.1")
            // Ours win over anything inherited, which would lock us out.
            .env("OPENCODE_SERVER_PASSWORD", &password)
            .env("OPENCODE_PASSWORD", &password)
            .env("OPENCODE_SERVER_USERNAME", "opencode")
            .env("OPENCODE_CLIENT", "hive")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            // Not `kill_on_drop`: killing the launcher first would leave the
            // tree kill nothing to walk from ([`Server`]'s `Drop`).
            .kill_on_drop(false);
        let dir = if cwd.is_empty() {
            home_dir()
        } else {
            Some(cwd.into())
        };
        if let Some(dir) = dir.filter(|d| d.is_dir()) {
            cmd.current_dir(dir);
        }
        #[cfg(windows)]
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        #[cfg(unix)]
        cmd.process_group(0);
        let mut child = cmd
            .spawn()
            .map_err(|e| (format!("Couldn't start opencode: {e}"), false))?;

        let stderr_tail = Arc::new(Mutex::new(String::new()));
        if let Some(stderr) = child.stderr.take() {
            tokio::spawn(collect_stderr(stderr, Arc::clone(&stderr_tail)));
        }
        // Drained for the server's whole life: a full pipe would block it.
        if let Some(stdout) = child.stdout.take() {
            tokio::spawn(async move {
                let mut lines = BufReader::new(stdout).lines();
                while let Ok(Some(_)) = lines.next_line().await {}
            });
        }

        use base64::Engine as _;
        let auth = format!(
            "Basic {}",
            base64::engine::general_purpose::STANDARD.encode(format!("opencode:{password}"))
        );
        let api = Api {
            base: format!("http://127.0.0.1:{port}"),
            auth,
            client: client(),
            directory: (!cwd.is_empty()).then(|| cwd.to_owned()),
        };
        let mut server = Server {
            child,
            api,
            stderr_tail,
            version: String::new(),
        };

        let deadline = tokio::time::Instant::now() + STARTUP_TIMEOUT;
        loop {
            if let Ok(Some(status)) = server.child.try_wait() {
                // Let the last of stderr arrive.
                tokio::time::sleep(Duration::from_millis(100)).await;
                let stderr = server.stderr();
                let retry = is_transient(&stderr);
                let code = status
                    .code()
                    .map_or("unknown".to_owned(), |c| c.to_string());
                let mut message = format!("opencode serve exited at startup (exit code {code}).");
                if !stderr.is_empty() {
                    message.push('\n');
                    message.push_str(&stderr);
                }
                return Err((message, retry));
            }
            match server.api.probe("/api/info").await {
                Probe::Version(version) => {
                    server.version = version;
                    return Ok(server);
                }
                Probe::Other => {
                    // Something answers, but not the 2.x API: an older opencode.
                    if let Probe::Version(version) = server.api.probe("/global/health").await {
                        server.shutdown().await;
                        return Err((
                            format!(
                                "OpenCode {version} is too old: Hive needs OpenCode 2. Update it in Settings › Providers, or run `opencode upgrade`."
                            ),
                            false,
                        ));
                    }
                }
                Probe::Down => {}
            }
            if tokio::time::Instant::now() >= deadline {
                server.shutdown().await;
                return Err((
                    format!(
                        "opencode serve didn't answer within {}s.",
                        STARTUP_TIMEOUT.as_secs()
                    ),
                    false,
                ));
            }
            tokio::time::sleep(HEALTH_POLL).await;
        }
    }

    /// The last of what the server printed to stderr.
    pub fn stderr(&self) -> String {
        self.stderr_tail.lock().unwrap().trim().to_owned()
    }

    /// Its exit, once it has exited.
    pub fn exited(&mut self) -> Option<ExitStatus> {
        self.child.try_wait().ok().flatten()
    }

    /// Takes the server and everything it started down.
    pub async fn shutdown(mut self) {
        kill_tree(&mut self.child).await;
    }
}

impl Drop for Server {
    /// A server dropped without [`Server::shutdown`] (its run ended early)
    /// still takes its children down. The launcher stays alive until the
    /// tree kill reaches it: killed first, its children would be orphaned.
    fn drop(&mut self) {
        let Some(pid) = self.child.id() else {
            return; // Already reaped.
        };
        let mut kill = if cfg!(windows) {
            let mut cmd = std::process::Command::new("taskkill");
            cmd.args(["/T", "/F", "/PID", &pid.to_string()]);
            cmd
        } else {
            let mut cmd = std::process::Command::new("kill");
            cmd.args(["-KILL", "--", &format!("-{pid}")]);
            cmd
        };
        kill.stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(windows)]
        std::os::windows::process::CommandExt::creation_flags(&mut kill, 0x0800_0000);
        if kill.spawn().is_err() {
            let _ = self.child.start_kill();
        }
    }
}

enum Probe {
    /// A JSON answer naming a version.
    Version(String),
    /// Some other answer.
    Other,
    /// No answer yet.
    Down,
}

impl Api {
    fn request(&self, method: reqwest::Method, path: &str) -> reqwest::RequestBuilder {
        let mut req = self
            .client
            .request(method, format!("{}{path}", self.base))
            .header(reqwest::header::AUTHORIZATION, &self.auth);
        if let Some(dir) = &self.directory {
            req = req.header("x-opencode-directory", percent_encode(dir));
        }
        req
    }

    /// Bounded: while the server boots it accepts connections but may never
    /// answer an early request.
    async fn probe(&self, path: &str) -> Probe {
        let sent = self
            .request(reqwest::Method::GET, path)
            .timeout(Duration::from_secs(2))
            .send()
            .await;
        let Ok(response) = sent else {
            return Probe::Down;
        };
        if !response.status().is_success() {
            return Probe::Other;
        }
        match response.json::<Value>().await {
            Ok(body) => match body["version"].as_str().or(body["data"]["version"].as_str()) {
                Some(v) if !v.trim().is_empty() => Probe::Version(v.to_owned()),
                _ => Probe::Other,
            },
            Err(_) => Probe::Other,
        }
    }

    pub async fn get(&self, path: &str) -> Result<Value, String> {
        self.call(reqwest::Method::GET, path, None).await
    }

    pub async fn post(&self, path: &str, body: &Value) -> Result<Value, String> {
        self.call(reqwest::Method::POST, path, Some(body)).await
    }

    pub async fn patch(&self, path: &str, body: &Value) -> Result<Value, String> {
        self.call(reqwest::Method::PATCH, path, Some(body)).await
    }

    pub async fn delete(&self, path: &str) -> Result<Value, String> {
        self.call(reqwest::Method::DELETE, path, None).await
    }

    /// A call answered with JSON; `data` is unwrapped where the answer has one.
    async fn call(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<&Value>,
    ) -> Result<Value, String> {
        self.call_with(method, path, body, Some(CALL_TIMEOUT)).await
    }

    /// [`Api::call`] without a time limit: `session.command` answers only
    /// once the turn it starts has ended.
    pub async fn post_unbounded(&self, path: &str, body: &Value) -> Result<Value, String> {
        self.call_with(reqwest::Method::POST, path, Some(body), None)
            .await
    }

    async fn call_with(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<&Value>,
        timeout: Option<Duration>,
    ) -> Result<Value, String> {
        let name = format!("{method} {path}");
        let mut req = self.request(method, path);
        if let Some(timeout) = timeout {
            req = req.timeout(timeout);
        }
        if let Some(body) = body {
            req = req.json(body);
        }
        let response = req
            .send()
            .await
            .map_err(|e| format!("OpenCode {name}: {e}"))?;
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(format!("OpenCode {name}: {status} {}", error_text(&text)));
        }
        let value: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
        Ok(match value.get("data") {
            Some(data) if !data.is_null() => data.clone(),
            _ => value,
        })
    }

    /// Follows `/api/event` until the receiver is dropped: every session's
    /// events, subagents' included. A dropped stream is reconnected; frames
    /// sent meanwhile are lost.
    pub fn subscribe(&self) -> mpsc::Receiver<Bus> {
        let (tx, rx) = mpsc::channel(1024);
        let api = Api {
            directory: None,
            ..self.clone()
        };
        tokio::spawn(async move {
            let mut failures = 0;
            let mut reason = String::new();
            while failures <= BUS_RECONNECTS {
                if failures > 0 {
                    tokio::time::sleep(BUS_RECONNECT_DELAY).await;
                }
                match api.stream_events(&tx).await {
                    Stream::Closed => return,
                    // A stream that delivered something earns a fresh budget.
                    Stream::Dropped { delivered, error } => {
                        failures = if delivered { 1 } else { failures + 1 };
                        reason = error;
                    }
                }
            }
            let _ = tx
                .send(Bus::Lost(format!("Lost the connection to OpenCode ({reason}).")))
                .await;
        });
        rx
    }

    async fn stream_events(&self, tx: &mpsc::Sender<Bus>) -> Stream {
        let response = self
            .request(reqwest::Method::GET, "/api/event")
            .header(reqwest::header::ACCEPT, "text/event-stream")
            .send()
            .await;
        let mut response = match response {
            Ok(r) if r.status().is_success() => r,
            Ok(r) => {
                return Stream::Dropped {
                    delivered: false,
                    error: format!("event stream answered {}", r.status()),
                }
            }
            Err(e) => {
                return Stream::Dropped {
                    delivered: false,
                    error: e.to_string(),
                }
            }
        };
        let mut decoder = SseDecoder::default();
        let mut delivered = false;
        loop {
            let chunk = match tokio::time::timeout(BUS_SILENCE, response.chunk()).await {
                Ok(Ok(Some(chunk))) => chunk,
                Ok(Ok(None)) => {
                    return Stream::Dropped {
                        delivered,
                        error: "event stream ended".into(),
                    }
                }
                Ok(Err(e)) => {
                    return Stream::Dropped {
                        delivered,
                        error: e.to_string(),
                    }
                }
                Err(_) => {
                    return Stream::Dropped {
                        delivered,
                        error: "event stream went silent".into(),
                    }
                }
            };
            for data in decoder.feed(&chunk) {
                let Ok(frame) = serde_json::from_str::<Value>(&data) else {
                    continue;
                };
                delivered = true;
                if tx.send(Bus::Frame(frame)).await.is_err() {
                    return Stream::Closed;
                }
            }
        }
    }
}

enum Stream {
    /// The receiver is gone.
    Closed,
    Dropped { delivered: bool, error: String },
}

/// Server-sent events: `data:` lines up to a blank line make one event;
/// comments (heartbeats) and other fields are skipped.
#[derive(Default)]
pub(super) struct SseDecoder {
    line: Vec<u8>,
    data: Vec<String>,
}

impl SseDecoder {
    pub fn feed(&mut self, bytes: &[u8]) -> Vec<String> {
        let mut events = Vec::new();
        for &b in bytes {
            if b != b'\n' {
                self.line.push(b);
                continue;
            }
            let mut line = std::mem::take(&mut self.line);
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            if line.is_empty() {
                if !self.data.is_empty() {
                    events.push(self.data.join("\n"));
                    self.data.clear();
                }
                continue;
            }
            let line = String::from_utf8_lossy(&line);
            if let Some(data) = line.strip_prefix("data:") {
                self.data
                    .push(data.strip_prefix(' ').unwrap_or(data).to_owned());
            }
        }
        events
    }
}

fn client() -> reqwest::Client {
    // Loopback only, never through a proxy, plain HTTP; reqwest still wants
    // a TLS provider in place to build a client.
    let _ = rustls::crypto::ring::default_provider().install_default();
    reqwest::Client::builder()
        .no_proxy()
        .connect_timeout(Duration::from_secs(2))
        .build()
        .unwrap_or_default()
}

/// opencode's own error bodies: `{ message }`, `{ data: { message } }`, …
fn error_text(body: &str) -> String {
    let parsed: Option<Value> = serde_json::from_str(body).ok();
    let message = parsed.as_ref().and_then(|v| {
        v["message"]
            .as_str()
            .or(v["data"]["message"].as_str())
            .or(v["error"]["message"].as_str())
            .map(str::to_owned)
    });
    let text = message.unwrap_or_else(|| body.trim().to_owned());
    if text.chars().count() > 300 {
        format!("{}…", text.chars().take(300).collect::<String>())
    } else {
        text
    }
}

/// A start that may succeed if tried again.
fn is_transient(stderr: &str) -> bool {
    let lower = stderr.to_ascii_lowercase();
    ["eaddrinuse", "address already in use", "database is locked", "sqlite_busy"]
        .iter()
        .any(|s| lower.contains(s))
}

fn free_port() -> Option<u16> {
    std::net::TcpListener::bind(("127.0.0.1", 0))
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .ok()
}

/// A password only this run knows.
fn secret() -> String {
    use sha2::{Digest, Sha256};
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default();
    let local = 0u8;
    let digest = Sha256::new()
        .chain_update(nanos.to_le_bytes())
        .chain_update(std::process::id().to_le_bytes())
        .chain_update(COUNTER.fetch_add(1, Ordering::Relaxed).to_le_bytes())
        .chain_update((&local as *const u8 as usize).to_le_bytes())
        .finalize();
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

/// As the official SDK sends the directory header: every byte outside the
/// unreserved set percent-encoded, `/` kept.
fn percent_encode(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for b in text.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

pub(super) fn home_dir() -> Option<std::path::PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .map(std::path::PathBuf::from)
}

/// Stops the process and everything it started.
async fn kill_tree(child: &mut Child) {
    if let Some(pid) = child.id() {
        #[cfg(windows)]
        {
            let mut taskkill = tokio::process::Command::new("taskkill");
            taskkill
                .args(["/T", "/F", "/PID", &pid.to_string()])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .creation_flags(0x0800_0000); // CREATE_NO_WINDOW
            let _ = tokio::time::timeout(Duration::from_secs(5), taskkill.status()).await;
        }
        #[cfg(unix)]
        {
            // The server leads its own process group.
            let _ = tokio::process::Command::new("kill")
                .args(["-TERM", "--", &format!("-{pid}")])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .await;
            if tokio::time::timeout(Duration::from_secs(2), child.wait())
                .await
                .is_ok()
            {
                return;
            }
            let _ = tokio::process::Command::new("kill")
                .args(["-KILL", "--", &format!("-{pid}")])
                .status()
                .await;
        }
    }
    let _ = child.kill().await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sse_frames_split_anywhere() {
        let mut d = SseDecoder::default();
        assert!(d.feed(b"data: {\"a\":").is_empty());
        assert!(d.feed(b"1}\r\n").is_empty());
        assert_eq!(d.feed(b"\r\n: heartbeat\n\ndata: x\ndata: y\n\n"), ["{\"a\":1}", "x\ny"]);
    }

    #[test]
    fn errors_read_from_bodies() {
        assert_eq!(error_text(r#"{"_tag":"X","message":"bad"}"#), "bad");
        assert_eq!(error_text("plain"), "plain");
        assert_eq!(percent_encode(r"C:\a b/c"), "C%3A%5Ca%20b/c");
        assert!(is_transient("Error: listen EADDRINUSE"));
    }
}
