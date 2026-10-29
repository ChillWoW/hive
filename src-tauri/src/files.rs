//! A chat folder's files for the composer's `@` menu, as in zeron: every
//! file and folder that `.gitignore` (and `.ignore`) doesn't hide, dotfiles
//! included, `.git` never.

use std::path::Path;

use hive_proto::WorkspaceEntry;

/// Past this the walk stops; ranking happens in the webview.
const MAX_ENTRIES: usize = 50_000;

fn list(root: &Path) -> Result<Vec<WorkspaceEntry>, String> {
    if !root.is_dir() {
        return Err(format!("{} is not a folder", root.display()));
    }
    let mut builder = ignore::WalkBuilder::new(root);
    builder
        .hidden(false)
        // A folder outside a checkout still means its `.gitignore`.
        .require_git(false)
        .follow_links(false)
        .filter_entry(|entry| entry.file_name() != ".git");

    let mut entries = Vec::new();
    for entry in builder.build() {
        let Ok(entry) = entry else { continue };
        if entry.depth() == 0 {
            continue;
        }
        let Ok(relative) = entry.path().strip_prefix(root) else {
            continue;
        };
        let Some(kind) = entry.file_type() else {
            continue;
        };
        // A link is listed as what it points at; nothing behind it is walked.
        let dir = kind.is_dir() || (kind.is_symlink() && entry.path().is_dir());
        let path = relative
            .components()
            .map(|part| part.as_os_str().to_string_lossy())
            .collect::<Vec<_>>()
            .join("/");
        entries.push(WorkspaceEntry { path, dir });
        if entries.len() >= MAX_ENTRIES {
            break;
        }
    }

    // Shallowest first, folders before files, then by name: what the menu
    // shows before anything is typed.
    entries.sort_by_cached_key(|entry| {
        (
            entry.path.matches('/').count(),
            !entry.dir,
            entry.path.to_lowercase(),
        )
    });
    Ok(entries)
}

#[tauri::command]
pub async fn list_files(cwd: String) -> Result<Vec<WorkspaceEntry>, String> {
    tokio::task::spawn_blocking(move || list(Path::new(&cwd)))
        .await
        .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("hive-files-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn lists_what_gitignore_does_not_hide() {
        let root = temp_dir("list");
        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::write(root.join(".git/HEAD"), "ref").unwrap();
        std::fs::create_dir_all(root.join("src/nested")).unwrap();
        std::fs::create_dir_all(root.join("target/debug")).unwrap();
        std::fs::write(root.join(".gitignore"), "target/\n*.log\n").unwrap();
        std::fs::write(root.join("README.md"), "").unwrap();
        std::fs::write(root.join("debug.log"), "").unwrap();
        std::fs::write(root.join("src/main.rs"), "").unwrap();
        std::fs::write(root.join("src/nested/a b.rs"), "").unwrap();
        std::fs::write(root.join("target/debug/app"), "").unwrap();

        let entries = list(&root).unwrap();
        let listed: Vec<_> = entries
            .iter()
            .map(|e| format!("{}{}", e.path, if e.dir { "/" } else { "" }))
            .collect();
        assert_eq!(
            listed,
            [
                "src/",
                ".gitignore",
                "README.md",
                "src/nested/",
                "src/main.rs",
                "src/nested/a b.rs"
            ]
        );

        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn a_missing_folder_is_an_error() {
        assert!(list(Path::new("/definitely/not/here")).is_err());
    }
}
