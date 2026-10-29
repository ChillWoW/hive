//! A folder's files, for the composer's `@` menu and the file panel.

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

/// One entry of a folder, as the file panel's tree lists it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryEntry {
    /// Relative to the chat's folder, `/`-separated, without a trailing slash.
    pub path: String,
    pub dir: bool,
    /// Hidden by `.gitignore`; listed only when everything is asked for.
    pub ignored: bool,
}
