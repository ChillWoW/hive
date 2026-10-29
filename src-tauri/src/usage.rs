//! The Usage panel's one command, over `hive_usage` (its scan cache and
//! price table live under `usage/` in the data dir).

use hive_proto::{UsageQuery, UsageReport};
use hive_usage::Usage;
use tauri::State;

#[tauri::command]
pub async fn usage_report(
    usage: State<'_, Usage>,
    query: UsageQuery,
) -> Result<UsageReport, String> {
    usage.report(query).await
}
