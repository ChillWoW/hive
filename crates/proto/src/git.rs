//! A project folder's git checkout as the branch picker shows it.

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
    /// The branch it tracks, e.g. `"origin/main"`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub upstream: Option<String>,
    /// Commits it has that its upstream doesn't.
    pub ahead: u32,
    /// Commits its upstream has that it doesn't.
    pub behind: u32,
    /// Its last commit, in Unix milliseconds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub committed_at: Option<u64>,
    /// The other worktree it's checked out in, which keeps it from being
    /// checked out or deleted here.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree: Option<String>,
    /// Its last commit's subject line.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subject: Option<String>,
}

/// A checkout's changes as one unified patch, for the diff tab: the working
/// tree (untracked files as new ones) against HEAD, or against the merge
/// base with another branch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct GitDiff {
    /// The checkout's top folder; the patch's paths are relative to it.
    pub root: String,
    /// The checked-out branch; missing on a detached HEAD.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    /// The short hash compared against when a base branch was given (its
    /// merge base with HEAD).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub merge_base: Option<String>,
    /// `git diff` output, then a section per untracked file.
    pub patch: String,
    /// The patch was cut at its size cap, or some files were left out.
    pub truncated: bool,
}

/// What a ref on a history row is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum GitHistoryRefKind {
    Branch,
    Remote,
    Tag,
}

/// A branch, remote branch or tag pointing at a history row's commit.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitHistoryRef {
    pub kind: GitHistoryRefKind,
    /// `main`, `origin/main`, `v1.2.0`.
    pub label: String,
}

/// One row of the history graph, in `git log --topo-order` order (children
/// before parents).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitHistoryCommit {
    pub sha: String,
    pub parent_shas: Vec<String>,
    pub subject: String,
    pub author_name: String,
    pub author_email: String,
    /// RFC 3339.
    pub authored_at: String,
    pub refs: Vec<GitHistoryRef>,
}

/// How the checked-out branch stands against the integration branch
/// (`upstream/main`, `origin/main`, …), from local refs only: Fetch all
/// brings newer remote state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitHistoryComparison {
    /// The remote-tracking ref compared with, e.g. `origin/main`.
    pub base: String,
    /// Commits in HEAD that `base` doesn't have.
    pub ahead: u32,
    /// Commits in `base` that HEAD doesn't have.
    pub behind: u32,
}

/// A page of a checkout's history (every branch, remote branch and tag), or
/// of a search through all of it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct GitHistoryPage {
    pub commits: Vec<GitHistoryCommit>,
    /// The tip of every local and remote branch (and HEAD), each commit once;
    /// first page only, for the branch-tips view.
    pub branch_tips: Vec<GitHistoryCommit>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub head_sha: Option<String>,
    /// Where the next page starts; missing on the last one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<u32>,
    /// Every commit listed (all of them, or every match); first page only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total_count: Option<u32>,
    /// Commits reachable from HEAD; first page only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub head_commit_count: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comparison: Option<GitHistoryComparison>,
}
