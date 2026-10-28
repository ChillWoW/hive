//! The branch picker's git commands, over `hive_git`, for a chat's folder.

use std::path::Path;

use hive_proto::GitRepo;

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
