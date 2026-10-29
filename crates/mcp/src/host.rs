//! The app's end: a loopback listener that runs [`Tools`] for bridges.
//!
//! One request per connection, one JSON line each way:
//! `{ token, chatId, method: "list" | "call", name, arguments }` →
//! `{ ok: value }` or `{ error: message }`. The token is random per launch
//! and kept in a file under the app's data dir; a request without it is
//! refused, so only processes that can read that file get in.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use hive_proto::McpServer;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};

use crate::{Ctx, Tools, PORT_ENV, TOKEN_FILE_ENV};

/// How long a bridge may take to send its request line.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
/// Largest request line accepted.
const MAX_REQUEST: u64 = 16 << 20;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Request {
    pub token: String,
    #[serde(default)]
    pub chat_id: Option<String>,
    pub method: Method,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub arguments: Value,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Method {
    List,
    Call,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Reply {
    Ok(Value),
    Error(String),
}

/// The listening host. Its accept loop runs for the life of the runtime it
/// was started on.
pub struct Host {
    port: u16,
    token_file: PathBuf,
}

impl Host {
    /// Listens on a free loopback port, writes a fresh token to
    /// `<dir>/mcp-token`, and serves `tools` on `runtime`.
    pub fn start(
        tools: Tools,
        dir: &Path,
        runtime: &tokio::runtime::Handle,
    ) -> std::io::Result<Self> {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0))?;
        listener.set_nonblocking(true)?;
        let port = listener.local_addr()?.port();
        let token = format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );
        std::fs::create_dir_all(dir)?;
        let token_file = dir.join("mcp-token");
        std::fs::write(&token_file, &token)?;

        let tools = Arc::new(tools);
        let token: Arc<str> = token.into();
        runtime.spawn(async move {
            let listener = match TcpListener::from_std(listener) {
                Ok(listener) => listener,
                Err(e) => {
                    eprintln!("hive mcp host: {e}");
                    return;
                }
            };
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    continue;
                };
                tokio::spawn(answer(stream, Arc::clone(&tools), Arc::clone(&token)));
            }
        });
        Ok(Self { port, token_file })
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    pub fn token_file(&self) -> &Path {
        &self.token_file
    }

    /// How an agent launches a bridge to this host: `command args…`, which
    /// must end up in [`crate::run_from_env`]. The engine adds the chat
    /// ([`McpServer::for_chat`]).
    pub fn server(&self, command: impl Into<String>, args: Vec<String>) -> McpServer {
        McpServer {
            name: McpServer::HIVE.into(),
            command: command.into(),
            args,
            env: [
                (PORT_ENV.to_owned(), self.port.to_string()),
                (
                    TOKEN_FILE_ENV.to_owned(),
                    self.token_file.to_string_lossy().into_owned(),
                ),
            ]
            .into(),
        }
    }
}

async fn answer(stream: TcpStream, tools: Arc<Tools>, token: Arc<str>) {
    let (read, mut write) = stream.into_split();
    let mut line = String::new();
    let mut reader = BufReader::new(read.take(MAX_REQUEST));
    let read = tokio::time::timeout(REQUEST_TIMEOUT, reader.read_line(&mut line)).await;
    let reply = match read {
        Ok(Ok(n)) if n > 0 => match serde_json::from_str::<Request>(&line) {
            Ok(request) if same(&request.token, &token) => {
                let ctx = Ctx {
                    chat_id: request.chat_id,
                };
                match request.method {
                    Method::List => {
                        Reply::Ok(serde_json::to_value(tools.defs()).unwrap_or_default())
                    }
                    Method::Call => match tools.call(&request.name, ctx, request.arguments).await {
                        Ok(value) => Reply::Ok(value),
                        Err(e) => Reply::Error(e),
                    },
                }
            }
            Ok(_) => Reply::Error("Hive refused the request: wrong token.".into()),
            Err(e) => Reply::Error(format!("bad request: {e}")),
        },
        _ => return,
    };
    let Ok(mut text) = serde_json::to_string(&reply) else {
        return;
    };
    text.push('\n');
    let _ = write.write_all(text.as_bytes()).await;
    let _ = write.shutdown().await;
}

/// Compares without stopping at the first difference.
fn same(a: &str, b: &str) -> bool {
    a.len() == b.len()
        && a.bytes()
            .zip(b.bytes())
            .fold(0u8, |acc, (x, y)| acc | (x ^ y))
            == 0
}
