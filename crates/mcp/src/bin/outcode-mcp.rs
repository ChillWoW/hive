//! The bridge on its own, for tests: what `outcode mcp` runs in the app.

fn main() {
    if let Err(e) = outcode_mcp::run_from_env() {
        eprintln!("outcode-mcp: {e}");
        std::process::exit(1);
    }
}
