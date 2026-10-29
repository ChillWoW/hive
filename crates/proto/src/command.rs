//! The command ledger: every instruction the user gives a chat's run, kept
//! durably with what became of it.
//!
//! The UI issues commands; the backend applies or rejects them and records
//! the outcome. A command still `pending` after a restart never ran, and is
//! expired at boot rather than executed late.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::agent::UserInputAnswer;
use crate::message::Attachment;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum CommandPayload {
    /// A prompt: starts the chat's first turn or the next one.
    #[serde(rename_all = "camelCase")]
    Send {
        prompt: String,
        /// The user message this prompt becomes, minted by the issuer so the
        /// UI can show it before the backend confirms.
        message_id: String,
        /// Files sent with it, already copied in by Hive.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        #[ts(as = "Option<Vec<Attachment>>", optional)]
        attachments: Vec<Attachment>,
    },
    #[serde(rename_all = "camelCase")]
    Answer {
        request_id: String,
        answers: Vec<UserInputAnswer>,
    },
    Interrupt,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum CommandStatus {
    Pending,
    Applied,
    Rejected,
    /// Never ran: Hive stopped before it was applied.
    Expired,
    /// Withdrawn by the user while still pending.
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct Command {
    pub id: String,
    pub chat_id: String,
    pub payload: CommandPayload,
    pub status: CommandStatus,
    /// Epoch millis.
    pub issued_at: i64,
    /// Epoch millis.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved_at: Option<i64>,
    /// Why it was rejected or expired.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolution: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn payload_wire_shape() {
        assert_eq!(
            serde_json::to_value(CommandPayload::Interrupt).unwrap(),
            json!({ "kind": "interrupt" })
        );
        assert_eq!(
            serde_json::to_value(CommandPayload::Send {
                prompt: "p".into(),
                message_id: "m1".into(),
                attachments: Vec::new(),
            })
            .unwrap(),
            json!({ "kind": "send", "prompt": "p", "messageId": "m1" })
        );
    }
}
