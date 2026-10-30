//! MCP over a byte stream: newline-delimited JSON-RPC 2.0.
//!
//! Requests run concurrently (a tool may take a while while the client
//! keeps pinging); replies go through one writer so lines never interleave.
//! Client notifications (`notifications/initialized`, `…/cancelled`) are
//! accepted and ignored.

use std::sync::Arc;

use serde_json::{json, Value};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::mpsc;

use crate::BoxFuture;

/// Revisions this server knows: the client's is echoed when it's one of
/// these, else the newest is offered and the client decides.
const PROTOCOL_VERSIONS: [&str; 4] = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const LATEST_PROTOCOL: &str = PROTOCOL_VERSIONS[0];

const INSTRUCTIONS: &str = "Hive is the desktop app running this session. \
These tools act on Hive itself (its chats, its window), not on the files you work on. \
To show the user an interactive chart, diagram, dashboard or mockup, check an HTML page \
with preview_html, then show it in the chat with render_html.";

const PARSE_ERROR: i64 = -32700;
const INVALID_REQUEST: i64 = -32600;
const METHOD_NOT_FOUND: i64 = -32601;
const INVALID_PARAMS: i64 = -32602;
const INTERNAL_ERROR: i64 = -32603;

/// Where tool requests go: the [`Bridge`] in `hive mcp`, the [`Tools`]
/// themselves in tests.
///
/// [`Bridge`]: crate::Bridge
/// [`Tools`]: crate::Tools
pub trait Backend: Send + Sync + 'static {
    /// `tools/list`'s `tools`.
    fn list(&self) -> BoxFuture<'_, Result<Value, String>>;
    /// A tool's result, or the error shown to the agent.
    fn call(&self, name: String, arguments: Value) -> BoxFuture<'_, Result<Value, String>>;
}

/// Serves MCP on `input`/`output` until `input` ends.
pub async fn serve<R, W>(backend: Arc<dyn Backend>, input: R, mut output: W) -> std::io::Result<()>
where
    R: AsyncBufRead + Unpin,
    W: AsyncWrite + Unpin + Send + 'static,
{
    let (out_tx, mut out_rx) = mpsc::channel::<String>(64);
    let writer = tokio::spawn(async move {
        while let Some(line) = out_rx.recv().await {
            let line = line + "\n";
            if output.write_all(line.as_bytes()).await.is_err() || output.flush().await.is_err() {
                break;
            }
        }
    });

    let mut lines = input.lines();
    while let Some(line) = lines.next_line().await? {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let message: Value = match serde_json::from_str(line) {
            Ok(value) => value,
            Err(e) => {
                let reply = error_response(Value::Null, PARSE_ERROR, &format!("parse error: {e}"));
                let _ = out_tx.send(reply.to_string()).await;
                continue;
            }
        };
        let Some(object) = message.as_object() else {
            let reply = error_response(Value::Null, INVALID_REQUEST, "expected a JSON-RPC object");
            let _ = out_tx.send(reply.to_string()).await;
            continue;
        };
        let id = object.get("id").cloned();
        let method = object
            .get("method")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let params = object.get("params").cloned().unwrap_or(Value::Null);
        match (id, method) {
            (Some(id), Some(method)) => {
                let backend = Arc::clone(&backend);
                let out = out_tx.clone();
                tokio::spawn(async move {
                    let reply = handle_request(backend.as_ref(), id, &method, params).await;
                    let _ = out.send(reply.to_string()).await;
                });
            }
            // A notification, or a reply to a request we never send.
            (None, Some(_)) | (Some(_), None) => {}
            (None, None) => {
                let reply = error_response(Value::Null, INVALID_REQUEST, "missing method");
                let _ = out_tx.send(reply.to_string()).await;
            }
        }
    }
    drop(out_tx);
    let _ = writer.await;
    Ok(())
}

/// The reply to one request.
pub async fn handle_request(
    backend: &dyn Backend,
    id: Value,
    method: &str,
    params: Value,
) -> Value {
    match method {
        "initialize" => {
            let requested = params["protocolVersion"]
                .as_str()
                .unwrap_or(LATEST_PROTOCOL);
            let version = if PROTOCOL_VERSIONS.contains(&requested) {
                requested
            } else {
                LATEST_PROTOCOL
            };
            ok_response(
                id,
                json!({
                    "protocolVersion": version,
                    "capabilities": { "tools": { "listChanged": false } },
                    "serverInfo": { "name": "hive", "version": env!("CARGO_PKG_VERSION") },
                    "instructions": INSTRUCTIONS,
                }),
            )
        }
        "ping" => ok_response(id, json!({})),
        "tools/list" => match backend.list().await {
            Ok(tools) => ok_response(id, json!({ "tools": tools })),
            Err(e) => error_response(id, INTERNAL_ERROR, &e),
        },
        "tools/call" => {
            let Some(name) = params["name"].as_str() else {
                return error_response(id, INVALID_PARAMS, "tools/call needs a tool name");
            };
            let arguments = match &params["arguments"] {
                Value::Null => json!({}),
                args => args.clone(),
            };
            match backend.call(name.to_owned(), arguments).await {
                Ok(value) => ok_response(
                    id,
                    json!({
                        "content": [{ "type": "text", "text": text(&value) }],
                        "structuredContent": structured(value),
                        "isError": false,
                    }),
                ),
                Err(message) => ok_response(
                    id,
                    json!({
                        "content": [{ "type": "text", "text": message }],
                        "isError": true,
                    }),
                ),
            }
        }
        // Capabilities not advertised: empty rather than an error, so
        // permissive clients don't log noise.
        "resources/list" => ok_response(id, json!({ "resources": [] })),
        "resources/templates/list" => ok_response(id, json!({ "resourceTemplates": [] })),
        "prompts/list" => ok_response(id, json!({ "prompts": [] })),
        other => error_response(id, METHOD_NOT_FOUND, &format!("unknown method: {other}")),
    }
}

/// `structuredContent` must be an object; anything else is wrapped.
fn structured(value: Value) -> Value {
    if value.is_object() {
        value
    } else {
        json!({ "result": value })
    }
}

fn text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        other => serde_json::to_string_pretty(other).unwrap_or_default(),
    }
}

fn ok_response(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn error_response(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Ctx, Tools};

    /// The tools called directly, as the chat `c1`.
    impl Backend for Tools {
        fn list(&self) -> BoxFuture<'_, Result<Value, String>> {
            Box::pin(async move { Ok(serde_json::to_value(self.defs()).unwrap()) })
        }
        fn call(&self, name: String, arguments: Value) -> BoxFuture<'_, Result<Value, String>> {
            let ctx = Ctx {
                chat_id: Some("c1".into()),
            };
            Box::pin(async move { Tools::call(self, &name, ctx, arguments).await })
        }
    }

    fn tools() -> Tools {
        Tools::new()
            .tool(
                "echo",
                "Echoes text.",
                json!({"type": "object"}),
                |ctx, args| async move { Ok(json!({ "text": args["text"], "chat": ctx.chat_id })) },
            )
            .tool("fail", "Fails.", json!({"type": "object"}), |_, _| async {
                Err::<Value, _>("nope".to_owned())
            })
            .tool(
                "plain",
                "A string.",
                json!({"type": "object"}),
                |_, _| async { Ok(json!("hi")) },
            )
    }

    /// Feeds `lines` and returns the replies, by id.
    async fn exchange(lines: &[Value]) -> Vec<Value> {
        let input: String = lines.iter().map(|l| format!("{l}\n")).collect();
        let (out, mut read) = tokio::io::duplex(1 << 16);
        serve(Arc::new(tools()), input.as_bytes(), out)
            .await
            .unwrap();
        let mut text = String::new();
        tokio::io::AsyncReadExt::read_to_string(&mut read, &mut text)
            .await
            .unwrap();
        let mut replies: Vec<Value> = text
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        replies.sort_by_key(|r| r["id"].as_i64().unwrap_or(-1));
        replies
    }

    #[tokio::test]
    async fn speaks_the_mcp_handshake_and_tools() {
        let replies = exchange(&[
            json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18"}}),
            json!({"jsonrpc": "2.0", "method": "notifications/initialized"}),
            json!({"jsonrpc": "2.0", "id": 2, "method": "tools/list"}),
            json!({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "echo", "arguments": {"text": "hey"}}}),
            json!({"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "fail"}}),
            json!({"jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": {"name": "plain"}}),
            json!({"jsonrpc": "2.0", "id": 6, "method": "tools/call", "params": {"name": "missing"}}),
            json!({"jsonrpc": "2.0", "id": 7, "method": "nope"}),
            json!({"jsonrpc": "2.0", "id": 8, "method": "ping"}),
        ])
        .await;
        // The notification gets no reply.
        assert_eq!(replies.len(), 8);
        assert_eq!(replies[0]["result"]["protocolVersion"], "2025-06-18");
        assert_eq!(replies[0]["result"]["serverInfo"]["name"], "hive");
        let names: Vec<&str> = replies[1]["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["name"].as_str().unwrap())
            .collect();
        assert_eq!(names, ["echo", "fail", "plain"]);
        assert!(replies[1]["result"]["tools"][0]["inputSchema"].is_object());
        assert_eq!(replies[2]["result"]["isError"], false);
        assert_eq!(
            replies[2]["result"]["structuredContent"],
            json!({"text": "hey", "chat": "c1"})
        );
        assert_eq!(replies[3]["result"]["isError"], true);
        assert_eq!(replies[3]["result"]["content"][0]["text"], "nope");
        assert_eq!(replies[4]["result"]["content"][0]["text"], "hi");
        assert_eq!(
            replies[4]["result"]["structuredContent"],
            json!({"result": "hi"})
        );
        assert_eq!(
            replies[5]["result"]["content"][0]["text"],
            "unknown tool: missing"
        );
        assert_eq!(replies[6]["error"]["code"], METHOD_NOT_FOUND);
        assert_eq!(replies[7]["result"], json!({}));
    }

    #[tokio::test]
    async fn offers_the_newest_revision_for_an_unknown_one_and_rejects_garbage() {
        let input = "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"1999-01-01\"}}\nnot json\n";
        let (out, mut read) = tokio::io::duplex(1 << 16);
        serve(Arc::new(tools()), input.as_bytes(), out)
            .await
            .unwrap();
        let mut text = String::new();
        tokio::io::AsyncReadExt::read_to_string(&mut read, &mut text)
            .await
            .unwrap();
        let replies: Vec<Value> = text
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        assert!(replies.iter().any(|r| r["error"]["code"] == PARSE_ERROR));
        assert!(replies
            .iter()
            .any(|r| r["result"]["protocolVersion"] == LATEST_PROTOCOL));
    }
}
