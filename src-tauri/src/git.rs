//! The branch picker's, diff tab's and history tab's git commands, over
//! `hive_git`, for a chat's folder.

use std::path::Path;

use hive_proto::{GitDiff, GitHistoryPage, GitRepo};

/// Null when `cwd` isn't in a checkout.
#[tauri::command]
pub async fn git_repo(cwd: String) -> Result<Option<GitRepo>, String> {
    hive_git::repo(Path::new(&cwd)).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_switch_branch(cwd: String, name: String) -> Result<(), String> {
    hive_git::switch(Path::new(&cwd), &name)
        .await
        .map_err(|e| e.to_string())
}

/// Branches off `from` and checks the new branch out.
#[tauri::command]
pub async fn git_create_branch(cwd: String, name: String, from: String) -> Result<(), String> {
    hive_git::create(Path::new(&cwd), &name, &from)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_delete_branch(cwd: String, name: String) -> Result<(), String> {
    hive_git::delete(Path::new(&cwd), &name)
        .await
        .map_err(|e| e.to_string())
}

/// The checkout's changes against HEAD, or with `base` against its merge
/// base with HEAD; null when `cwd` isn't in a checkout.
#[tauri::command]
pub async fn git_diff(cwd: String, base: Option<String>) -> Result<Option<GitDiff>, String> {
    hive_git::diff(Path::new(&cwd), base.as_deref())
        .await
        .map_err(|e| e.to_string())
}

/// What a chat's latest prompted turn changed in its checkout so far; null
/// before its first turn since launch (or outside a checkout).
#[tauri::command]
pub async fn git_turn_diff(
    engine: tauri::State<'_, hive_engine::Engine>,
    chat_id: String,
) -> Result<Option<GitDiff>, String> {
    engine.turn_diff(&chat_id).await.map_err(|e| e.to_string())
}

/// `limit` commits of the checkout's history from `cursor` on (every branch,
/// remote branch and tag, children first); null outside a checkout.
#[tauri::command]
pub async fn git_history(
    cwd: String,
    cursor: Option<usize>,
    limit: Option<usize>,
) -> Result<Option<GitHistoryPage>, String> {
    hive_git::history(
        Path::new(&cwd),
        cursor.unwrap_or(0),
        limit.unwrap_or(hive_git::HISTORY_DEFAULT_LIMIT),
    )
    .await
    .map_err(|e| e.to_string())
}

/// The commits matching `query` through the whole history, a page at a time.
#[tauri::command]
pub async fn git_search_history(
    cwd: String,
    query: String,
    cursor: Option<usize>,
    limit: Option<usize>,
) -> Result<Option<GitHistoryPage>, String> {
    hive_git::search_history(
        Path::new(&cwd),
        &query,
        cursor.unwrap_or(0),
        limit.unwrap_or(hive_git::HISTORY_DEFAULT_LIMIT),
    )
    .await
    .map_err(|e| e.to_string())
}

/// `git fetch --all`: remote branches only, never HEAD or the files.
#[tauri::command]
pub async fn git_fetch_all(cwd: String) -> Result<(), String> {
    hive_git::fetch_all(Path::new(&cwd))
        .await
        .map_err(|e| e.to_string())
}

/// What one commit changed, against its first parent.
#[tauri::command]
pub async fn git_commit_diff(cwd: String, sha: String) -> Result<Option<GitDiff>, String> {
    hive_git::commit_diff(Path::new(&cwd), &sha)
        .await
        .map_err(|e| e.to_string())
}
