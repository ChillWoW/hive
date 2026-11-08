//! Pi's sessions: `$PI_CODING_AGENT_SESSION_DIR`, else
//! `$PI_CODING_AGENT_DIR` (else `~/.pi/agent`) `/sessions/**/*.jsonl`. Each
//! file opens with a `session` header (id, cwd); each assistant `message`
//! carries its request's `usage` (uncached input, cache read/write, output
//! with reasoning inside) and Pi's own `cost.total`. A forked session copies
//! its history into a new file: `responseId` tells the copies apart.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::files::Format;
use crate::record::{
    fnv, parse_time, reported_cost, Record, Records, CACHE_READ, CACHE_WRITE, INPUT, OUTPUT,
    REASONING,
};

pub fn roots() -> Vec<PathBuf> {
    let env = |name: &str| std::env::var_os(name).filter(|d| !d.is_empty()).map(PathBuf::from);
    if let Some(dir) = env("PI_CODING_AGENT_SESSION_DIR") {
        return vec![dir];
    }
    env("PI_CODING_AGENT_DIR")
        .or_else(|| crate::home().map(|h| h.join(".pi").join("agent")))
        .map(|d| vec![d.join("sessions")])
        .unwrap_or_default()
}

/// What the file's header said.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Pi {
    session: Option<String>,
    cwd: Option<String>,
}

#[derive(Deserialize)]
struct Line {
    #[serde(rename = "type")]
    kind: Option<String>,
    id: Option<String>,
    cwd: Option<String>,
    timestamp: Option<String>,
    message: Option<Message>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Message {
    role: Option<String>,
    provider: Option<String>,
    model: Option<String>,
    response_id: Option<String>,
    usage: Option<Usage>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Usage {
    input: Option<u64>,
    output: Option<u64>,
    cache_read: Option<u64>,
    cache_write: Option<u64>,
    reasoning: Option<u64>,
    cost: Option<Cost>,
}

#[derive(Deserialize)]
struct Cost {
    total: Option<f64>,
}

impl Format for Pi {
    const MARKERS: &'static [&'static str] = &["\"usage\"", "\"type\":\"session\""];

    fn parse(&mut self, line: &str, out: &mut Records) {
        let Ok(line) = serde_json::from_str::<Line>(line) else { return };
        match line.kind.as_deref() {
            Some("session") => {
                self.session = line.id;
                self.cwd = line.cwd;
                return;
            }
            Some("message") => {}
            _ => return,
        }
        let Some(message) = line.message else { return };
        if message.role.as_deref() != Some("assistant") {
            return;
        }
        let Some(usage) = message.usage else { return };
        let Some(at) = line.timestamp.as_deref().and_then(parse_time) else { return };
        let Some(model) = message.model.filter(|m| !m.is_empty()) else { return };
        let mut counts = [0; 6];
        counts[INPUT] = usage.input.unwrap_or(0);
        counts[CACHE_READ] = usage.cache_read.unwrap_or(0);
        counts[CACHE_WRITE] = usage.cache_write.unwrap_or(0);
        counts[OUTPUT] = usage.output.unwrap_or(0);
        counts[REASONING] = usage.reasoning.unwrap_or(0).min(counts[OUTPUT]);
        // An aborted or failed request before any tokens.
        if counts.iter().all(|&n| n == 0) {
            return;
        }
        // As Hive names Pi's models.
        let model = match message.provider.as_deref().filter(|p| !p.is_empty()) {
            Some(p) => format!("{p}/{model}"),
            None => model,
        };
        let key = match &message.response_id {
            Some(id) if !id.is_empty() => fnv(id.as_bytes()),
            _ => fnv(format!("{at}:{model}:{counts:?}").as_bytes()),
        };
        let model = out.intern(&model);
        let session = out.intern_or_none(self.session.as_deref());
        let project = out.intern_or_none(self.cwd.as_deref());
        out.push(Record {
            at,
            model,
            session,
            project,
            counts,
            cost: reported_cost(usage.cost.and_then(|c| c.total)),
            fast: false,
            key,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_header_and_assistant_usage() {
        let mut out = Records::default();
        let mut p = Pi::default();
        p.parse(r#"{"type":"session","version":3,"id":"s1","timestamp":"2026-11-08T19:26:15.008Z","cwd":"E:\\dev\\hive"}"#, &mut out);
        p.parse(r#"{"type":"message","id":"u","timestamp":"2026-11-08T19:26:20.638Z","message":{"role":"user","content":[]}}"#, &mut out);
        p.parse(r#"{"type":"message","id":"a","timestamp":"2026-11-08T19:26:22.821Z","message":{"role":"assistant","content":[],"provider":"explabs","model":"deepseek-v4.1-flash","usage":{"input":38809,"output":93,"cacheRead":5,"cacheWrite":0,"reasoning":69,"totalTokens":38907,"cost":{"total":0.0117}},"responseId":"r1"}}"#, &mut out);
        // An aborted request.
        p.parse(r#"{"type":"message","id":"b","timestamp":"2026-11-08T19:26:23.000Z","message":{"role":"assistant","content":[],"provider":"explabs","model":"m","usage":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"cost":{"total":0}}}}"#, &mut out);
        assert_eq!(out.records.len(), 1);
        let r = &out.records[0];
        assert_eq!(r.counts, [38809, 5, 0, 93, 69, 0]);
        assert_eq!(r.cost, Some(0.0117));
        assert_eq!(out.string(r.model), Some("explabs/deepseek-v4.1-flash"));
        assert_eq!(out.string(r.session), Some("s1"));
        assert_eq!(out.string(r.project), Some("E:\\dev\\hive"));
    }
}
