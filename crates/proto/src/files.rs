//! A folder's files as the composer's `@` menu lists them.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// A file or folder under a chat's folder.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceEntry {
    /// Relative to the folder, `/`-separated, without a trailing slash.
    pub path: String,
    pub dir: bool,
}
