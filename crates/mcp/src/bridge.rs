//! The bridge's end: each MCP tool request becomes one request to the
//! [`Host`](crate::Host).

use std::path::PathBuf;

use hive_proto::McpServer;
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;

use crate::host::{Method, Reply, Request};
use crate::{Backend, BoxFuture, PORT_ENV, TOKEN_FILE_ENV};

/// Where the host is and who's asking, from the bridge's environment.
#[derive(Debug, Clone, Default)]
pub struct Bridge {
    port: Option<u16>,
    token_file: Option<PathBuf>,
    chat_id: Option<String>,
}

impl Bridge {
    pub fn from_env() -> Self {
        let read = |key: &str| {
            std::env::var(key)
                .ok()
                .map(|v| v.trim().to_owned())
                .filter(|v| !v.is_empty())
        };
        Self {
            port: read(PORT_ENV).and_then(|p| p.parse().ok()),
            token_file: read(TOKEN_FILE_ENV).map(PathBuf::from),
            chat_id: read(McpServer::CHAT_ID_ENV),
        }
    }

    async fn request(
        &self,
        method: Method,
        name: String,
        arguments: Value,
    ) -> Result<Value, String> {
        let (Some(port), Some(token_file)) = (self.port, &self.token_file) else {
            return Err(format!(
                "This server only works when Hive launches it ({PORT_ENV} / {TOKEN_FILE_ENV} unset)."
            ));
        };
        // Read every time: the file always holds the running app's token.
        let token = tokio::fs::read_to_string(token_file)
            .await
            .map_err(|e| format!("Can't read Hive's token ({}): {e}", token_file.display()))?;
        let request = Request {
            token: token.trim().to_owned(),
            chat_id: self.chat_id.clone(),
            method,
            name,
            arguments,
        };
        let mut line = serde_json::to_string(&request).map_err(|e| e.to_string())?;
        line.push('\n');
        let mut stream = TcpStream::connect(("127.0.0.1", port)).await.map_err(|e| {
            format!("Hive isn't reachable on port {port} ({e}). Is it still running?")
        })?;
        stream
            .write_all(line.as_bytes())
            .await
            .map_err(|e| e.to_string())?;
        let mut reply = String::new();
        BufReader::new(stream)
            .read_line(&mut reply)
            .await
            .map_err(|e| e.to_string())?;
        if reply.trim().is_empty() {
            return Err("Hive closed the connection without answering.".into());
        }
        match serde_json::from_str(&reply).map_err(|e| format!("bad reply from Hive: {e}"))? {
            Reply::Ok(value) => Ok(value),
            Reply::Error(e) => Err(e),
        }
    }
}

impl Backend for Bridge {
    fn list(&self) -> BoxFuture<'_, Result<Value, String>> {
        Box::pin(self.request(Method::List, String::new(), Value::Null))
    }

    fn call(&self, name: String, arguments: Value) -> BoxFuture<'_, Result<Value, String>> {
        Box::pin(self.request(Method::Call, name, arguments))
    }
}
