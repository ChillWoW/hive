//! The branch picker's git commands, over `outcode_git`, for a chat's folder.

use std::path::Path;

use outcode_proto::GitRepo;

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
