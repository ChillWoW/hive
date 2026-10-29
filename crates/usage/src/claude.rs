//! Claude Code's transcripts: `$CLAUDE_CONFIG_DIR` (else `~/.claude`)
//! `/projects/**/*.jsonl`, one assistant line per content block, each
//! repeating its message's whole `usage`; `message.id` + `requestId` tell the
//! copies apart from new requests.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::files::Format;
use crate::record::{
    fnv, parse_time, Record, Records, CACHE_READ, CACHE_WRITE, CACHE_WRITE_1H, INPUT, NONE,
    OUTPUT,
};

pub fn roots() -> Vec<PathBuf> {
    let dir = std::env::var_os("CLAUDE_CONFIG_DIR")
        .filter(|d| !d.is_empty())
        .map(PathBuf::from)
        .or_else(|| crate::home().map(|h| h.join(".claude")));
    dir.map(|d| vec![d.join("projects")]).unwrap_or_default()
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Claude;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Line {
    #[serde(rename = "type")]
    kind: Option<String>,
    timestamp: Option<String>,
    request_id: Option<String>,
    session_id: Option<String>,
    cwd: Option<String>,
    #[serde(rename = "costUSD")]
    cost_usd: Option<f64>,
    message: Option<Message>,
}

#[derive(Deserialize)]
struct Message {
    id: Option<String>,
    model: Option<String>,
    usage: Option<Usage>,
}

#[derive(Deserialize)]
struct Usage {
    input_tokens: Option<u64>,
    cache_read_input_tokens: Option<u64>,
    cache_creation_input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    cache_creation: Option<CacheCreation>,
    speed: Option<String>,
}

#[derive(Deserialize)]
struct CacheCreation {
    ephemeral_1h_input_tokens: Option<u64>,
}

impl Format for Claude {
    const MARKERS: &'static [&'static str] = &["\"usage\""];

    fn parse(&mut self, line: &str, out: &mut Records) {
        let Ok(line) = serde_json::from_str::<Line>(line) else { return };
        if line.kind.as_deref() != Some("assistant") {
            return;
        }
        let Some(message) = line.message else { return };
        let Some(usage) = message.usage else { return };
        let Some(at) = line.timestamp.as_deref().and_then(parse_time) else { return };
        let model = message.model.unwrap_or_default();
        // Local placeholders that never reached the API.
        if model.is_empty() || model == "<synthetic>" {
            return;
        }
        let key = match (&message.id, &line.request_id) {
            (None, None) => 0,
            (id, request) => fnv(
                format!("{}:{}", id.as_deref().unwrap_or(""), request.as_deref().unwrap_or(""))
                    .as_bytes(),
            ),
        };
        let mut counts = [0; 6];
        counts[INPUT] = usage.input_tokens.unwrap_or(0);
        counts[CACHE_READ] = usage.cache_read_input_tokens.unwrap_or(0);
        counts[CACHE_WRITE] = usage.cache_creation_input_tokens.unwrap_or(0);
        // Thinking is folded into output and not broken out.
        counts[OUTPUT] = usage.output_tokens.unwrap_or(0);
        counts[CACHE_WRITE_1H] = usage
            .cache_creation
            .and_then(|c| c.ephemeral_1h_input_tokens)
            .unwrap_or(0)
            .min(counts[CACHE_WRITE]);
        let model = out.intern(&model);
        let session = line.session_id.as_deref().map_or(NONE, |s| out.intern(s));
        let project = line.cwd.as_deref().map_or(NONE, |s| out.intern(s));
        out.push(Record {
            at,
            model,
            session,
            project,
            counts,
            cost: line.cost_usd.filter(|c| c.is_finite() && *c > 0.0),
            fast: usage.speed.as_deref() == Some("fast"),
            key,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(id: &str, out: u64) -> String {
        format!(
            r#"{{"type":"assistant","timestamp":"2026-10-29T21:17:41.022Z","requestId":"req_1","sessionId":"s1","cwd":"E:\\dev\\hive","message":{{"model":"claude-opus-5-5","id":"{id}","usage":{{"input_tokens":2,"cache_creation_input_tokens":300,"cache_read_input_tokens":4000,"cache_creation":{{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":300}},"output_tokens":{out},"speed":"standard"}}}}}}"#
        )
    }

    #[test]
    fn parses_and_merges_content_blocks() {
        let mut out = Records::default();
        let mut c = Claude;
        c.parse(&line("msg_1", 10), &mut out);
        c.parse(&line("msg_1", 140), &mut out);
        c.parse(&line("msg_2", 5), &mut out);
        c.parse(r#"{"type":"user","message":{"usage":{}}}"#, &mut out);
        assert_eq!(out.records.len(), 2);
        let r = &out.records[0];
        assert_eq!(r.counts, [2, 4000, 300, 140, 0, 300]);
        assert_eq!(out.string(r.model), Some("claude-opus-5-5"));
        assert_eq!(out.string(r.project), Some("E:\\dev\\hive"));
        assert_eq!(out.string(r.session), Some("s1"));
    }
}
