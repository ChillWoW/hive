//! Claude CLI stream-json frames: stdout JSONL in, stdin lines out.
//!
//! Tolerant by construction: every field defaults and unknown frame types
//! parse as [`Frame::Other`], so a newer CLI never breaks parsing. Only the
//! fields the normalizer reads are modeled.

use serde::Deserialize;
use serde_json::{json, Value};

/// One parsed stdout line.
#[derive(Debug)]
pub(crate) enum Frame {
    System(SystemFrame),
    StreamEvent(StreamEventFrame),
    Assistant(MessageFrame),
    User(MessageFrame),
    RateLimit(RateLimitFrame),
    Result(ResultFrame),
    /// The CLI asking us something (`can_use_tool`).
    ControlRequest(ControlRequestFrame),
    /// The CLI's answer to one of our control requests.
    ControlResponse(ControlResponseFrame),
    Other,
}

#[derive(Debug, Default, Deserialize)]
pub(crate) struct SystemFrame {
    #[serde(default)]
    pub subtype: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub tools: Vec<String>,
    #[serde(default)]
    pub cwd: String,
    #[serde(default)]
    pub session_id: String,
    /// `task_notification`: the spawning tool call's id.
    #[serde(default)]
    pub tool_use_id: Option<String>,
    /// `task_notification`: terminal status (`completed`, `failed`, …).
    #[serde(default)]
    pub status: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
pub(crate) struct StreamEventFrame {
    #[serde(default)]
    pub parent_tool_use_id: Option<String>,
    #[serde(default)]
    pub event: StreamEventBody,
}

#[derive(Debug, Default, Deserialize)]
pub(crate) struct StreamEventBody {
    #[serde(rename = "type", default)]
    pub kind: String,
    #[serde(default)]
    pub delta: Delta,
}

#[derive(Debug, Default, Deserialize)]
pub(crate) struct Delta {
    #[serde(rename = "type", default)]
    pub kind: String,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub thinking: String,
}

/// An `assistant` or `user` frame: an Anthropic API message envelope.
#[derive(Debug, Default, Deserialize)]
pub(crate) struct MessageFrame {
    #[serde(default)]
    pub parent_tool_use_id: Option<String>,
    #[serde(default)]
    pub message: MessageBody,
    /// Assistant-level error code (`rate_limit`, `billing_error`, …).
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
pub(crate) struct MessageBody {
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub usage: Option<Value>,
    /// A plain string or an array of content blocks.
    #[serde(default)]
    pub content: Value,
}

impl MessageBody {
    pub fn blocks(&self) -> impl Iterator<Item = ContentBlock> + '_ {
        self.content
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or_default()
            .iter()
            .filter_map(|b| serde_json::from_value(b.clone()).ok())
    }
}

#[derive(Debug, Default, Deserialize)]
pub(crate) struct ContentBlock {
    #[serde(rename = "type", default)]
    pub kind: String,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub input: Value,
    #[serde(default)]
    pub tool_use_id: String,
    #[serde(default)]
    pub is_error: Option<bool>,
    /// A `tool_result`'s output: a string or an array of text blocks.
    #[serde(default)]
    pub content: Value,
}

impl ContentBlock {
    pub fn result_text(&self) -> Option<String> {
        let text = match &self.content {
            Value::String(s) => s.clone(),
            Value::Array(blocks) => blocks
                .iter()
                .filter_map(|b| b.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n"),
            _ => return None,
        };
        (!text.trim().is_empty()).then_some(text)
    }
}

#[derive(Debug, Default, Deserialize)]
pub(crate) struct RateLimitFrame {
    #[serde(default)]
    pub rate_limit_info: RateLimitInfo,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RateLimitInfo {
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub rate_limit_type: Option<String>,
    /// `allowed`/`allowed_warning` when the account may spend overage past a
    /// rejected window.
    #[serde(default)]
    pub overage_status: Option<String>,
    #[serde(default)]
    pub is_using_overage: bool,
}

impl RateLimitInfo {
    /// A rejected window that actually blocks the turn.
    pub fn blocks(&self) -> bool {
        self.status == "rejected"
            && !matches!(
                self.overage_status.as_deref(),
                Some("allowed" | "allowed_warning")
            )
            && !self.is_using_overage
    }
}

#[derive(Debug, Default, Deserialize)]
pub(crate) struct ResultFrame {
    #[serde(default)]
    pub subtype: String,
    #[serde(default)]
    pub errors: Vec<Value>,
    #[serde(default)]
    pub usage: UsageBody,
    #[serde(default, rename = "modelUsage")]
    pub model_usage: std::collections::BTreeMap<String, Value>,
    #[serde(default)]
    pub session_id: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
pub(crate) struct UsageBody {
    #[serde(default)]
    pub input_tokens: u64,
    #[serde(default)]
    pub output_tokens: u64,
}

#[derive(Debug, Default, Deserialize)]
pub(crate) struct ControlResponseFrame {
    #[serde(default)]
    pub response: ControlResponseBody,
}

#[derive(Debug, Default, Deserialize)]
pub(crate) struct ControlResponseBody {
    #[serde(default)]
    pub request_id: String,
    #[serde(default)]
    pub response: Value,
}

#[derive(Debug, Default, Deserialize)]
pub(crate) struct ControlRequestFrame {
    #[serde(default)]
    pub request_id: String,
    #[serde(default)]
    pub request: ControlRequestBody,
}

#[derive(Debug, Default, Deserialize)]
pub(crate) struct ControlRequestBody {
    #[serde(default)]
    pub subtype: String,
    #[serde(default)]
    pub tool_name: String,
    /// `can_use_tool`: the tool's name as shown to people (an MCP tool's
    /// own), and what the model says the call is for.
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub input: Value,
}

/// Parses one stdout line. `Err` means it wasn't JSON.
pub(crate) fn parse_frame(line: &str) -> Result<Frame, serde_json::Error> {
    let value: Value = serde_json::from_str(line)?;
    let kind = value.get("type").and_then(Value::as_str).unwrap_or("");
    Ok(match kind {
        "system" => Frame::System(serde_json::from_value(value)?),
        "stream_event" => Frame::StreamEvent(serde_json::from_value(value)?),
        "assistant" => Frame::Assistant(serde_json::from_value(value)?),
        "user" => Frame::User(serde_json::from_value(value)?),
        "rate_limit_event" => Frame::RateLimit(serde_json::from_value(value)?),
        "result" => Frame::Result(serde_json::from_value(value)?),
        "control_request" => Frame::ControlRequest(serde_json::from_value(value)?),
        "control_response" => Frame::ControlResponse(serde_json::from_value(value)?),
        _ => Frame::Other,
    })
}

/// A user turn on stdin.
pub(crate) fn user_line(text: &str) -> String {
    json!({
        "type": "user",
        "message": { "role": "user", "content": text },
        "parent_tool_use_id": null,
    })
    .to_string()
}

/// The session's opening control request.
pub(crate) fn initialize_line(request_id: &str) -> String {
    control_request_line(request_id, json!({ "subtype": "initialize" }))
}

/// Stops the in-flight turn; the process keeps reading stdin.
pub(crate) fn interrupt_line(request_id: &str) -> String {
    control_request_line(request_id, json!({ "subtype": "interrupt" }))
}

fn control_request_line(request_id: &str, request: Value) -> String {
    json!({ "type": "control_request", "request_id": request_id, "request": request }).to_string()
}

/// Our reply to a CLI control request.
pub(crate) fn control_response_line(request_id: &str, response: Value) -> String {
    json!({
        "type": "control_response",
        "response": { "subtype": "success", "request_id": request_id, "response": response },
    })
    .to_string()
}

/// `can_use_tool` allow, with the (possibly rewritten) tool input.
pub(crate) fn allow(updated_input: Value) -> Value {
    json!({ "behavior": "allow", "updatedInput": updated_input })
}

/// `can_use_tool` allow for `ExitPlanMode` that leaves plan mode for `mode`.
/// Without it the CLI drops to `default`.
pub(crate) fn exit_plan(updated_input: Value, mode: &str) -> Value {
    json!({
        "behavior": "allow",
        "updatedInput": updated_input,
        "updatedPermissions": [{ "type": "setMode", "mode": mode, "destination": "session" }],
    })
}

/// `can_use_tool` deny: the model reads `message` as the tool's result.
pub(crate) fn deny(message: &str) -> Value {
    json!({ "behavior": "deny", "message": message })
}

/// Switches the live process's permission mode.
pub(crate) fn set_permission_mode_line(request_id: &str, mode: &str) -> String {
    json!({
        "type": "control_request",
        "request_id": request_id,
        "request": { "subtype": "set_permission_mode", "mode": mode },
    })
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_known_and_unknown_frames() {
        let init = r#"{"type":"system","subtype":"init","model":"m","tools":["Bash"],"cwd":"/x","session_id":"s1"}"#;
        let Frame::System(f) = parse_frame(init).unwrap() else {
            panic!("expected a system frame");
        };
        assert_eq!((f.subtype.as_str(), f.session_id.as_str()), ("init", "s1"));
        assert!(matches!(
            parse_frame(r#"{"type":"mystery"}"#).unwrap(),
            Frame::Other
        ));
        assert!(parse_frame("not json").is_err());
    }

    #[test]
    fn tool_result_text_reads_both_shapes() {
        let block = |content: Value| ContentBlock {
            content,
            ..Default::default()
        };
        assert_eq!(block(json!("ok")).result_text().as_deref(), Some("ok"));
        assert_eq!(
            block(json!([{ "type": "text", "text": "a" }, { "type": "text", "text": "b" }]))
                .result_text()
                .as_deref(),
            Some("a\nb")
        );
        assert_eq!(block(json!("  ")).result_text(), None);
    }

    #[test]
    fn user_line_matches_protocol() {
        let v: Value = serde_json::from_str(&user_line("hi")).unwrap();
        assert_eq!(v["type"], "user");
        assert_eq!(v["message"]["content"], "hi");
        assert!(v["parent_tool_use_id"].is_null());
    }
}
