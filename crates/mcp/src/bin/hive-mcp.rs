//! The bridge on its own, for tests and `hive-run`: what the app runs as
//! `hive mcp`.

fn main() {
    if let Err(e) = hive_mcp::run_from_env() {
        eprintln!("hive-mcp: {e}");
        std::process::exit(1);
    }
}
