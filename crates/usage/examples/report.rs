//! Prints this machine's usage over the last N days (default 30), with a
//! scan cache in a temp dir unless `--data <dir>` is given:
//! `cargo run -p hive-usage --release --example report -- 30`.

use std::collections::BTreeMap;

use hive_proto::UsageQuery;
use hive_usage::Usage;

#[tokio::main(flavor = "multi_thread")]
async fn main() {
    let mut args = std::env::args().skip(1);
    let mut days = 30i64;
    let mut data = std::env::temp_dir().join("hive-usage-example");
    while let Some(arg) = args.next() {
        if arg == "--data" {
            data = args.next().expect("--data <dir>").into();
        } else {
            days = arg.parse().expect("days");
        }
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    let day = 86_400_000;
    let start = (now / day - days + 1) * day;
    let query = UsageQuery {
        buckets: (0..days).map(|d| start + d * day).collect(),
        until: now + 1,
        refresh_prices: false,
    };
    let usage = Usage::new(&data);
    for pass in ["cold", "warm"] {
        let t = std::time::Instant::now();
        let report = usage.report(query.clone()).await.unwrap();
        println!("{pass}: {:?} (scan {} ms)", t.elapsed(), report.scan_ms);
        if pass == "warm" {
            for s in &report.sources {
                println!("  source {:?} {:?} files={} {:?}", s.harness, s.status, s.files, s.error);
            }
            println!("  pricing {:?}", report.pricing);
            let mut by: BTreeMap<String, (f64, u64, u32, u32)> = BTreeMap::new();
            for r in &report.rows {
                let e = by.entry(format!("{:?} {}", r.harness, r.model)).or_default();
                e.0 += r.cost.input + r.cost.cache_read + r.cost.cache_write + r.cost.output + r.cost.other;
                e.1 += r.tokens.input + r.tokens.cache_read + r.tokens.cache_write + r.tokens.output;
                e.2 += r.requests;
                e.3 += r.unpriced;
            }
            let total: f64 = by.values().map(|v| v.0).sum();
            for (k, (cost, tokens, req, unp)) in by {
                println!("  {k:60} ${cost:>10.2} {tokens:>14} tok {req:>7} req {unp:>6} unpriced");
            }
            println!("  total ${total:.2}, sessions {}", report.sessions);
            for p in report.projects.iter().take(5) {
                let cost: f64 = p.harnesses.iter().map(|h| h.cost).sum();
                let sessions: u32 = p.harnesses.iter().map(|h| h.sessions).sum();
                println!("  project {} ${cost:.2} {sessions} sessions", p.path);
            }
        }
    }
}
