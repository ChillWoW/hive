//! Codex's rollouts: `$CODEX_HOME` (else `~/.codex`) `/sessions/**/*.jsonl`
//! and `/archived_sessions`. `token_count` events carry no model, so the
//! last `turn_context`'s is carried forward (and the service tier from
//! `thread_settings_applied`). Each event's `last_token_usage` is one request,
//! checked against the running `total_token_usage` to drop re-emits; a forked
//! session's copied history (a burst right after its meta) is skipped. As in
//! t3code.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::files::Format;
use crate::record::{
    parse_time, Record, Records, CACHE_READ, CACHE_WRITE, INPUT, NONE, OUTPUT, REASONING,
};

pub fn roots() -> Vec<PathBuf> {
    let home = std::env::var_os("CODEX_HOME")
        .filter(|d| !d.is_empty())
        .map(PathBuf::from)
        .or_else(|| crate::home().map(|h| h.join(".codex")));
    home.map(|h| vec![h.join("sessions"), h.join("archived_sessions")])
        .unwrap_or_default()
}

/// Forks copy their parent's history in a burst (gaps of a few ms); the
/// child's own first request comes seconds later.
const FORK_COPY_MAX_GAP_MS: i64 = 1000;

/// input, cached input, cache write, output, reasoning, total.
type Usage = [u64; 6];

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Codex {
    model: String,
    fast: bool,
    session: String,
    cwd: String,
    saw_meta: bool,
    last: Option<Usage>,
    cumulative: Option<Usage>,
    suppressing: bool,
    fork_anchor: i64,
}

fn usage(value: &Value) -> Option<Usage> {
    let field = |k: &str| value.get(k).and_then(Value::as_u64);
    let input = field("input_tokens")?;
    let output = field("output_tokens")?;
    let u = [
        input,
        field("cached_input_tokens").unwrap_or(0),
        field("cache_write_input_tokens").unwrap_or(0),
        output,
        field("reasoning_output_tokens").unwrap_or(0),
        field("total_tokens").unwrap_or(input + output),
    ];
    let valid = u[1] + u[2] <= u[0] && u[4] <= u[3] && u[5] >= u[0] + u[3];
    valid.then_some(u)
}

fn add(a: Option<Usage>, b: &Usage) -> Option<Usage> {
    let a = a.unwrap_or_default();
    let mut sum = [0; 6];
    for i in 0..6 {
        sum[i] = a[i] + b[i];
    }
    let valid = sum[1] + sum[2] <= sum[0] && sum[4] <= sum[3] && sum[5] >= sum[0] + sum[3];
    valid.then_some(sum)
}

impl Format for Codex {
    const MARKERS: &'static [&'static str] =
        &["\"token_count\"", "\"turn_context\"", "\"thread_settings_applied\"", "\"session_meta\""];

    fn parse(&mut self, line: &str, out: &mut Records) {
        let Ok(line) = serde_json::from_str::<Value>(line) else { return };
        let Some(payload) = line.get("payload").filter(|p| p.is_object()) else { return };
        let kind = line.get("type").and_then(Value::as_str);
        let payload_kind = payload.get("type").and_then(Value::as_str);
        let at = line.get("timestamp").and_then(Value::as_str).and_then(parse_time);

        if kind == Some("session_meta") {
            // Only the first one is this session's; later ones are copied ancestors.
            if self.saw_meta {
                return;
            }
            self.saw_meta = true;
            if let Some(id) = payload.get("id").or(payload.get("session_id")).and_then(Value::as_str) {
                self.session = id.to_owned();
            }
            if let Some(cwd) = payload.get("cwd").and_then(Value::as_str) {
                self.cwd = cwd.to_owned();
            }
            let forked = payload.get("forked_from_id").is_some_and(Value::is_string)
                || payload
                    .pointer("/source/subagent/thread_spawn/parent_thread_id")
                    .is_some_and(Value::is_string);
            if let (true, Some(at)) = (forked, at) {
                self.suppressing = true;
                self.fork_anchor = at;
            }
            return;
        }
        if kind == Some("turn_context") {
            if let Some(model) = payload.get("model").and_then(Value::as_str) {
                self.model = model.to_owned();
            }
            if let Some(cwd) = payload.get("cwd").and_then(Value::as_str) {
                self.cwd = cwd.to_owned();
            }
            return;
        }
        if payload_kind == Some("thread_settings_applied") {
            if let Some(tier) = payload.pointer("/thread_settings/service_tier") {
                self.fast = matches!(tier.as_str(), Some("priority" | "fast" | "ultrafast"));
            }
            return;
        }
        if payload_kind != Some("token_count") {
            return;
        }
        let Some(info) = payload.get("info").filter(|i| i.is_object()) else { return };
        let Some(at) = at else { return };
        if self.model.is_empty() {
            return;
        }
        let last = info.get("last_token_usage").and_then(usage);
        let raw_cumulative = info.get("total_token_usage").filter(|v| !v.is_null());
        let cumulative = raw_cumulative.and_then(usage);

        if self.suppressing {
            if at - self.fork_anchor < FORK_COPY_MAX_GAP_MS {
                // Billed in the parent, but it sets the child's baseline.
                self.fork_anchor = at;
                if cumulative.is_some() {
                    self.cumulative = cumulative;
                } else if let (None, Some(last)) = (raw_cumulative, last) {
                    if Some(last) != self.last {
                        self.cumulative = add(self.cumulative, &last);
                    }
                }
                self.last = last;
                return;
            }
            self.suppressing = false;
            self.last = None;
        }

        let previous = self.cumulative;
        if cumulative.is_some() {
            self.cumulative = cumulative;
        }
        let Some(last) = last else { return };
        if raw_cumulative.is_some() && cumulative.is_none() {
            return;
        }
        // Zero requests only report the context's size.
        if last[0] + last[3] == 0 {
            self.last = None;
            return;
        }
        if cumulative.is_some() && cumulative == previous {
            return;
        }
        if last[5] != last[0] + last[3] {
            return;
        }
        if let Some(cumulative) = cumulative {
            // A resumed session restarts its counters at this request.
            let restarted = cumulative == last;
            let reconciled = match previous {
                None => {
                    let mut prefix = [0; 6];
                    let mut ok = true;
                    for i in 0..6 {
                        match cumulative[i].checked_sub(last[i]) {
                            Some(v) => prefix[i] = v,
                            None => ok = false,
                        }
                    }
                    ok && prefix[1] + prefix[2] <= prefix[0] && prefix[4] <= prefix[3]
                }
                Some(previous) => (0..6).all(|i| cumulative[i].checked_sub(previous[i]) == Some(last[i])),
            };
            if !restarted && !reconciled {
                return;
            }
        } else {
            if Some(last) == self.last {
                return;
            }
            match add(previous, &last) {
                Some(advanced) => self.cumulative = Some(advanced),
                None => return,
            }
        }
        self.last = Some(last);

        let mut counts = [0; 6];
        // `input_tokens` includes the cached part.
        counts[INPUT] = last[0] - last[1] - last[2];
        counts[CACHE_READ] = last[1];
        counts[CACHE_WRITE] = last[2];
        counts[OUTPUT] = last[3];
        counts[REASONING] = last[4];
        let model = out.intern(&self.model.clone());
        let session = if self.session.is_empty() { NONE } else { out.intern(&self.session.clone()) };
        let project = if self.cwd.is_empty() { NONE } else { out.intern(&self.cwd.clone()) };
        out.push(Record {
            at,
            model,
            session,
            project,
            counts,
            cost: None,
            fast: self.fast,
            key: 0,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn token_count(at: &str, last: [u64; 3], total: [u64; 3]) -> String {
        let u = |[i, c, o]: [u64; 3]| {
            format!(
                r#"{{"input_tokens":{i},"cached_input_tokens":{c},"cache_write_input_tokens":0,"output_tokens":{o},"reasoning_output_tokens":0,"total_tokens":{}}}"#,
                i + o
            )
        };
        format!(
            r#"{{"timestamp":"{at}","type":"event_msg","payload":{{"type":"token_count","info":{{"total_token_usage":{},"last_token_usage":{},"model_context_window":258400}}}}}}"#,
            u(total),
            u(last)
        )
    }

    #[test]
    fn counts_each_request_once() {
        let mut out = Records::default();
        let mut c = Codex::default();
        for line in [
            r#"{"timestamp":"2026-10-29T18:31:45.599Z","type":"session_meta","payload":{"id":"s1","cwd":"C:\\p"}}"#.to_owned(),
            r#"{"timestamp":"2026-10-29T18:31:47.142Z","type":"turn_context","payload":{"model":"gpt-6-luna","cwd":"C:\\p"}}"#.to_owned(),
            token_count("2026-10-29T18:31:48.395Z", [100, 60, 10], [100, 60, 10]),
            // Re-emitted: same totals.
            token_count("2026-10-29T18:31:48.500Z", [100, 60, 10], [100, 60, 10]),
            token_count("2026-10-29T18:31:50.000Z", [200, 150, 20], [300, 210, 30]),
            // Doesn't add up: dropped.
            token_count("2026-10-29T18:31:51.000Z", [50, 0, 5], [999, 210, 30]),
        ] {
            c.parse(&line, &mut out);
        }
        let got: Vec<_> = out.records.iter().map(|r| (r.counts[INPUT], r.counts[CACHE_READ], r.counts[OUTPUT])).collect();
        assert_eq!(got, vec![(40, 60, 10), (50, 150, 20)]);
        assert_eq!(out.string(out.records[0].model), Some("gpt-6-luna"));
        assert_eq!(out.string(out.records[0].project), Some("C:\\p"));
    }

    #[test]
    fn skips_a_forks_copied_history() {
        let mut out = Records::default();
        let mut c = Codex::default();
        for line in [
            r#"{"timestamp":"2026-10-29T18:00:00.000Z","type":"session_meta","payload":{"id":"child","forked_from_id":"parent"}}"#.to_owned(),
            r#"{"timestamp":"2026-10-29T18:00:00.010Z","type":"turn_context","payload":{"model":"gpt-6-luna"}}"#.to_owned(),
            token_count("2026-10-29T18:00:00.020Z", [100, 0, 10], [100, 0, 10]),
            token_count("2026-10-29T18:00:09.000Z", [120, 100, 5], [220, 100, 15]),
        ] {
            c.parse(&line, &mut out);
        }
        assert_eq!(out.records.len(), 1);
        assert_eq!(out.records[0].counts[OUTPUT], 5);
    }
}
