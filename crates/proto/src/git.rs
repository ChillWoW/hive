//! A project folder's git checkout, as the branch picker shows it.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// The checkout a folder is in: what's checked out and its local branches.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct GitRepo {
    /// The checkout's top folder.
    pub root: String,
    /// The checked-out branch; missing on a detached HEAD.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    /// HEAD's short hash; missing before the first commit.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub commit: Option<String>,
    /// Files with uncommitted changes, untracked ones included.
    pub changes: u32,
    /// Local branches, most recently committed first.
    pub branches: Vec<GitBranch>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct GitBranch {
    pub name: String,
    /// Checked out in this folder.
    pub current: bool,
    /// Its commits are all in HEAD, so deleting it loses nothing.
    pub merged: bool,
    /// Its last commit, in Unix milliseconds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub committed_at: Option<u64>,
    /// The other worktree it's checked out in, which keeps it from being
    /// checked out or deleted here.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree: Option<String>,
}

/// A checkout's uncommitted changes, as the changes tab shows them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct GitChanges {
    /// The checkout's top folder; the patch's paths are relative to it.
    pub root: String,
    /// A git patch from HEAD to the working tree, untracked files included
    /// as new ones.
    pub patch: String,
    /// Untracked files left out of the patch: too many, or too big.
    pub skipped: u32,
}
