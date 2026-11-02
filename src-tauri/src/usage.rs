//! The Usage panel's command and a chat's cost, over `hive_usage` (its scan cache and
//! price table live under `usage/` in the data dir).

use hive_proto::{HarnessId, SessionUsage, UsageQuery, UsageReport};
use hive_usage::Usage;
use tauri::State;

#[tauri::command]
pub async fn usage_report(
    usage: State<'_, Usage>,
    query: UsageQuery,
) -> Result<UsageReport, String> {
    usage.report(query).await
}

/// What one CLI session (a chat's `harnessSessionId`) cost, over all its history.
#[tauri::command]
pub async fn usage_session(
    usage: State<'_, Usage>,
    harness: HarnessId,
    session_id: String,
) -> Result<SessionUsage, String> {
    usage.session(harness, session_id).await
}
