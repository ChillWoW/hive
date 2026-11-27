//! The branch picker's, changes tab's and history tab's git commands, over
//! `outcode_git`, for a chat's folder.

use std::collections::HashMap;
use std::path::Path;

use outcode_proto::{GitChanges, GitCommitDetail, GitFileState, GitHistoryPage, GitRepo};

fn err(error: impl std::fmt::Display) -> String {
    error.to_string()
}

/// Null when `cwd` isn't in a checkout.
#[tauri::command]
pub async fn git_repo(cwd: String) -> Result<Option<GitRepo>, String> {
    outcode_git::repo(Path::new(&cwd)).await.map_err(err)
}

#[tauri::command]
pub async fn git_switch_branch(cwd: String, name: String) -> Result<(), String> {
    outcode_git::switch(Path::new(&cwd), &name).await.map_err(err)
}

/// Branches off `from` and checks the new branch out.
#[tauri::command]
pub async fn git_create_branch(cwd: String, name: String, from: String) -> Result<(), String> {
    outcode_git::create(Path::new(&cwd), &name, &from).await.map_err(err)
}

#[tauri::command]
pub async fn git_delete_branch(cwd: String, name: String) -> Result<(), String> {
    outcode_git::delete(Path::new(&cwd), &name).await.map_err(err)
}

/// The checkout's uncommitted changes as a patch; null when `cwd` isn't in one.
#[tauri::command]
pub async fn git_changes(cwd: String) -> Result<Option<GitChanges>, String> {
    outcode_git::changes(Path::new(&cwd)).await.map_err(err)
}

/// Each uncommitted file at or under `cwd`, by its path from `cwd`; null when
/// `cwd` isn't in a checkout.
#[tauri::command]
pub async fn git_status(cwd: String) -> Result<Option<HashMap<String, GitFileState>>, String> {
    let files = outcode_git::status_under(Path::new(&cwd)).await.map_err(err)?;
    Ok(files.map(|files| files.into_iter().collect()))
}

/// `limit` commits of the checkout's history from `cursor` on (every branch,
/// remote branch and tag, children first); null outside a checkout.
#[tauri::command]
pub async fn git_history(
    cwd: String,
    cursor: Option<usize>,
    limit: Option<usize>,
) -> Result<Option<GitHistoryPage>, String> {
    outcode_git::history(
        Path::new(&cwd),
        cursor.unwrap_or(0),
        limit.unwrap_or(outcode_git::HISTORY_DEFAULT_LIMIT),
    )
    .await
    .map_err(err)
}

/// The commits matching `query` through the whole history, a page at a time.
#[tauri::command]
pub async fn git_search_history(
    cwd: String,
    query: String,
    cursor: Option<usize>,
    limit: Option<usize>,
) -> Result<Option<GitHistoryPage>, String> {
    outcode_git::search_history(
        Path::new(&cwd),
        &query,
        cursor.unwrap_or(0),
        limit.unwrap_or(outcode_git::HISTORY_DEFAULT_LIMIT),
    )
    .await
    .map_err(err)
}

/// `git fetch --all`: remote branches only, never HEAD or the files.
#[tauri::command]
pub async fn git_fetch_all(cwd: String) -> Result<(), String> {
    outcode_git::fetch_all(Path::new(&cwd)).await.map_err(err)
}

/// One commit's message and what it changed against its first parent; null
/// outside a checkout.
#[tauri::command]
pub async fn git_commit_detail(
    cwd: String,
    sha: String,
) -> Result<Option<GitCommitDetail>, String> {
    outcode_git::commit_detail(Path::new(&cwd), &sha)
        .await
        .map_err(err)
}
