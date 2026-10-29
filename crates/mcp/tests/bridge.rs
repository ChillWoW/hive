//! The `hive-mcp` bridge as an agent's CLI runs it: a child process spoken
//! to over stdin/stdout, relaying to a [`Host`] in this process.

use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use hive_mcp::{Ctx, Host, McpServer, Tools};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};

const WAIT: Duration = Duration::from_secs(20);

struct Bridge {
    child: Child,
    stdin: ChildStdin,
    stdout: Lines<BufReader<ChildStdout>>,
    next_id: i64,
}

impl Bridge {
    fn spawn(server: &McpServer) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_hive-mcp"))
            .args(&server.args)
            .env_clear()
            .envs(std::env::vars().filter(|(k, _)| !k.starts_with("HIVE_")))
            .envs(&server.env)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let stdin = child.stdin.take().unwrap();
        let stdout = BufReader::new(child.stdout.take().unwrap()).lines();
        Self {
            child,
            stdin,
            stdout,
            next_id: 0,
        }
    }

    async fn request(&mut self, method: &str, params: Value) -> Value {
        self.next_id += 1;
        let id = self.next_id;
        let line = json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params})
            .to_string()
            + "\n";
        self.stdin.write_all(line.as_bytes()).await.unwrap();
        tokio::time::timeout(WAIT, async {
            loop {
                let line = self
                    .stdout
                    .next_line()
                    .await
                    .unwrap()
                    .expect("bridge exited");
                let reply: Value = serde_json::from_str(&line).unwrap();
                if reply["id"] == id {
                    return reply;
                }
            }
        })
        .await
        .expect("no reply in time")
    }

    async fn notify(&mut self, method: &str) {
        let line = json!({"jsonrpc": "2.0", "method": method}).to_string() + "\n";
        self.stdin.write_all(line.as_bytes()).await.unwrap();
    }

    async fn close(mut self) {
        drop(self.stdin);
        let status = tokio::time::timeout(WAIT, self.child.wait())
            .await
            .unwrap()
            .unwrap();
        assert!(status.success(), "{status}");
    }
}

fn tools(calls: Arc<Mutex<Vec<(Ctx, Value)>>>) -> Tools {
    Tools::new().tool(
        "echo",
        "Echoes `text` back.",
        json!({"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]}),
        move |ctx, args| {
            calls.lock().unwrap().push((ctx.clone(), args.clone()));
            async move { Ok(json!({ "echo": args["text"], "chat": ctx.chat_id })) }
        },
    )
}

#[tokio::test(flavor = "multi_thread")]
async fn relays_tools_to_the_host_as_the_chat() {
    let dir = tempfile::tempdir().unwrap();
    let calls = Arc::new(Mutex::new(Vec::new()));
    let host = Host::start(
        tools(Arc::clone(&calls)),
        dir.path(),
        &tokio::runtime::Handle::current(),
    )
    .unwrap();
    let server = host
        .server(env!("CARGO_BIN_EXE_hive-mcp"), vec![])
        .for_chat("chat-1");
    assert_eq!(server.name, "hive");

    let mut bridge = Bridge::spawn(&server);
    let init = bridge
        .request("initialize", json!({"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "t", "version": "0"}}))
        .await;
    assert_eq!(init["result"]["serverInfo"]["name"], "hive");
    bridge.notify("notifications/initialized").await;

    let list = bridge.request("tools/list", json!({})).await;
    assert_eq!(list["result"]["tools"][0]["name"], "echo");
    assert_eq!(
        list["result"]["tools"][0]["inputSchema"]["required"],
        json!(["text"])
    );

    let call = bridge
        .request(
            "tools/call",
            json!({"name": "echo", "arguments": {"text": "pineapple"}}),
        )
        .await;
    assert_eq!(call["result"]["isError"], false, "{call}");
    assert_eq!(
        call["result"]["structuredContent"],
        json!({"echo": "pineapple", "chat": "chat-1"})
    );

    let unknown = bridge.request("tools/call", json!({"name": "nope"})).await;
    assert_eq!(unknown["result"]["isError"], true);
    assert_eq!(
        unknown["result"]["content"][0]["text"],
        "unknown tool: nope"
    );

    // Several at once over the one bridge.
    let mut ids = Vec::new();
    for n in 0..5 {
        bridge.next_id += 1;
        ids.push(bridge.next_id);
        let line = json!({"jsonrpc": "2.0", "id": bridge.next_id, "method": "tools/call",
            "params": {"name": "echo", "arguments": {"text": n.to_string()}}})
        .to_string()
            + "\n";
        bridge.stdin.write_all(line.as_bytes()).await.unwrap();
    }
    for _ in 0..5 {
        let line = tokio::time::timeout(WAIT, bridge.stdout.next_line())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let reply: Value = serde_json::from_str(&line).unwrap();
        assert!(ids.contains(&reply["id"].as_i64().unwrap()));
        assert_eq!(reply["result"]["isError"], false);
    }
    bridge.close().await;

    let calls = calls.lock().unwrap();
    assert_eq!(calls.len(), 6);
    assert!(calls
        .iter()
        .all(|(ctx, _)| ctx.chat_id.as_deref() == Some("chat-1")));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_wrong_token_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let calls = Arc::new(Mutex::new(Vec::new()));
    let host = Host::start(
        tools(Arc::clone(&calls)),
        dir.path(),
        &tokio::runtime::Handle::current(),
    )
    .unwrap();
    let mut server = host.server("unused", vec![]);
    let forged = dir.path().join("forged");
    std::fs::write(&forged, "not-the-token").unwrap();
    server.env.insert(
        hive_mcp::TOKEN_FILE_ENV.into(),
        forged.to_string_lossy().into_owned(),
    );

    let mut bridge = Bridge::spawn(&server);
    let list = bridge.request("tools/list", json!({})).await;
    assert!(
        list["error"]["message"]
            .as_str()
            .unwrap()
            .contains("wrong token"),
        "{list}"
    );
    let call = bridge
        .request(
            "tools/call",
            json!({"name": "echo", "arguments": {"text": "x"}}),
        )
        .await;
    assert_eq!(call["result"]["isError"], true);
    bridge.close().await;
    assert!(calls.lock().unwrap().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn without_a_host_it_still_answers_and_says_why() {
    let mut bridge = Bridge::spawn(&McpServer::default());
    let init = bridge.request("initialize", json!({})).await;
    assert!(init["result"].is_object());
    let call = bridge.request("tools/call", json!({"name": "echo"})).await;
    assert_eq!(call["result"]["isError"], true);
    assert!(call["result"]["content"][0]["text"]
        .as_str()
        .unwrap()
        .contains("only works when Hive launches it"));
    bridge.close().await;
}
