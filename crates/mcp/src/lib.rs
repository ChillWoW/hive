//! hive-mcp — Hive's own MCP server, through which agents reach Hive.
//!
//! Two halves, as in zeron:
//!
//! - [`Host`], inside the app: a loopback TCP listener that runs [`Tools`]
//!   (the catalog and the code behind each tool, with the app's state at
//!   hand). Every connection carries one request and the token only the app
//!   and its own files know.
//! - The bridge, `hive mcp` (the app's own executable with an `mcp`
//!   argument; `hive-mcp` in tests): one per agent session, launched by the
//!   agent's CLI from the [`McpServer`] the engine stamps on each run. It
//!   speaks MCP (JSON-RPC 2.0, one message per line) on stdin/stdout and
//!   relays `tools/list` and `tools/call` to the host, tagged with the chat
//!   it was launched for ([`McpServer::CHAT_ID_ENV`]).
//!
//! The tool catalog lives in the app, so adding a tool is one
//! [`Tools::tool`] call there; the bridge never changes.
//!
//! The MCP side is hand-rolled: a tool server needs `initialize`, `ping`,
//! `tools/list`, `tools/call` and the `initialized` notification.

mod bridge;
mod host;
mod protocol;
mod tools;

use std::future::Future;
use std::pin::Pin;

pub use bridge::Bridge;
pub use hive_proto::McpServer;
pub use host::Host;
pub use protocol::{handle_request, serve, Backend};
pub use tools::{Ctx, ToolDef, Tools};

/// The host's loopback port.
pub const PORT_ENV: &str = "HIVE_MCP_PORT";
/// The file holding the host's token. A path, not the token itself: Claude
/// gets the server's env on its command line (`--mcp-config`), where other
/// processes can read it.
pub const TOKEN_FILE_ENV: &str = "HIVE_MCP_TOKEN_FILE";

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// `hive mcp`: serves MCP on stdin/stdout, relaying to the host named by the
/// environment, until stdin closes. Nothing else may write to stdout.
pub fn run_from_env() -> std::io::Result<()> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    runtime.block_on(serve(
        std::sync::Arc::new(Bridge::from_env()),
        tokio::io::BufReader::new(tokio::io::stdin()),
        tokio::io::stdout(),
    ))
}
