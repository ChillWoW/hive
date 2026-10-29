// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
  // `hive mcp`: an agent's CLI launched us as Hive's MCP server (see
  // `mcp.rs`). Speaks MCP on stdin/stdout and relays to the running app;
  // no window, nothing else on stdout.
  if std::env::args().nth(1).as_deref() == Some("mcp") {
    if let Err(e) = hive_mcp::run_from_env() {
      eprintln!("hive mcp: {e}");
      std::process::exit(1);
    }
    return;
  }
  app_lib::run();
}
