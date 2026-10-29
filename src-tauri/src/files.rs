//! A chat folder's files, as in zeron: every file and folder that
//! `.gitignore` (and `.ignore`) doesn't hide, dotfiles included, `.git`
//! never; `all` lists the ignored ones too. `list_files` walks the whole
//! folder (the composer's `@` menu, the file panel's search), `list_directory`
//! one folder of it (the file panel's tree).

use std::collections::HashSet;
use std::path::{Component, Path};

use hive_proto::{DirectoryEntry, WorkspaceEntry};

/// Past this the walk stops; ranking happens in the webview.
const MAX_ENTRIES: usize = 50_000;

/// A walk of `dir`, `depth` levels down (all of it for `None`).
fn walker(dir: &Path, depth: Option<usize>, all: bool) -> ignore::WalkBuilder {
    let mut builder = ignore::WalkBuilder::new(dir);
    builder
        .max_depth(depth)
        .hidden(false)
        // A folder outside a checkout still means its `.gitignore`.
        .require_git(false)
        .follow_links(false)
        .filter_entry(|entry| entry.file_name() != ".git");
    if all {
        builder.standard_filters(false);
    }
    builder
}

/// `path` relative to `root`, `/`-separated.
fn relative(root: &Path, path: &Path) -> Option<String> {
    let relative = path.strip_prefix(root).ok()?;
    Some(
        relative
            .components()
            .map(|part| part.as_os_str().to_string_lossy())
            .collect::<Vec<_>>()
            .join("/"),
    )
}

/// A link counts as what it points at; nothing behind it is walked.
fn is_dir(entry: &ignore::DirEntry) -> Option<bool> {
    let kind = entry.file_type()?;
    Some(kind.is_dir() || (kind.is_symlink() && entry.path().is_dir()))
}

fn check_root(root: &Path) -> Result<(), String> {
    if root.is_dir() {
        Ok(())
    } else {
        Err(format!("{} is not a folder", root.display()))
    }
}

fn list(root: &Path, all: bool) -> Result<Vec<WorkspaceEntry>, String> {
    check_root(root)?;
    let mut entries = Vec::new();
    for entry in walker(root, None, all).build() {
        let Ok(entry) = entry else { continue };
        if entry.depth() == 0 {
            continue;
        }
        let (Some(path), Some(dir)) = (relative(root, entry.path()), is_dir(&entry)) else {
            continue;
        };
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

/// What's directly in `dir` (relative to `root`; "" is `root` itself),
/// folders first, then by name.
fn list_dir(root: &Path, dir: &str, all: bool) -> Result<Vec<DirectoryEntry>, String> {
    check_root(root)?;
    let dir = Path::new(dir);
    if !dir.components().all(|part| matches!(part, Component::Normal(_))) {
        return Err(format!("{} is not inside the folder", dir.display()));
    }
    let target = root.join(dir);
    if !target.is_dir() {
        return Err(format!("{} is not a folder", target.display()));
    }

    let children = |all: bool| {
        walker(&target, Some(1), all)
            .build()
            .filter_map(Result::ok)
            .filter(|entry| entry.depth() == 1)
    };
    // With `all`, whatever the filters wouldn't have kept is the ignored part.
    let kept: Option<HashSet<_>> =
        all.then(|| children(false).map(|entry| entry.into_path()).collect());

    let mut entries = Vec::new();
    for entry in children(all) {
        let (Some(path), Some(dir)) = (relative(root, entry.path()), is_dir(&entry)) else {
            continue;
        };
        let ignored = kept.as_ref().is_some_and(|kept| !kept.contains(entry.path()));
        entries.push(DirectoryEntry { path, dir, ignored });
        if entries.len() >= MAX_ENTRIES {
            break;
        }
    }
    entries.sort_by_cached_key(|entry| {
        let name = entry.path.rsplit('/').next().unwrap_or_default();
        (!entry.dir, name.to_lowercase(), name.to_owned())
    });
    Ok(entries)
}

#[tauri::command]
pub async fn list_files(cwd: String, all: Option<bool>) -> Result<Vec<WorkspaceEntry>, String> {
    tokio::task::spawn_blocking(move || list(Path::new(&cwd), all.unwrap_or(false)))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn list_directory(
    cwd: String,
    dir: String,
    all: bool,
) -> Result<Vec<DirectoryEntry>, String> {
    tokio::task::spawn_blocking(move || list_dir(Path::new(&cwd), &dir, all))
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

    /// A checkout with an ignored folder and file, a dotfile and nesting.
    fn project(name: &str) -> std::path::PathBuf {
        let root = temp_dir(name);
        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::write(root.join(".git/HEAD"), "ref").unwrap();
        std::fs::create_dir_all(root.join("src/nested")).unwrap();
        std::fs::create_dir_all(root.join("target/debug")).unwrap();
        std::fs::write(root.join(".gitignore"), "target/\n*.log\n").unwrap();
        std::fs::write(root.join("README.md"), "").unwrap();
        std::fs::write(root.join("debug.log"), "").unwrap();
        std::fs::write(root.join("src/main.rs"), "").unwrap();
        std::fs::write(root.join("src/debug.log"), "").unwrap();
        std::fs::write(root.join("src/nested/a b.rs"), "").unwrap();
        std::fs::write(root.join("target/debug/app"), "").unwrap();
        root
    }

    fn shown(entries: &[DirectoryEntry]) -> Vec<String> {
        entries
            .iter()
            .map(|e| {
                format!(
                    "{}{}{}",
                    e.path,
                    if e.dir { "/" } else { "" },
                    if e.ignored { " (ignored)" } else { "" }
                )
            })
            .collect()
    }

    #[test]
    fn lists_what_gitignore_does_not_hide() {
        let root = project("list");
        let entries = list(&root, false).unwrap();
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
        assert!(list(&root, true).unwrap().iter().any(|e| e.path == "target/debug/app"));
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn lists_one_folder() {
        let root = project("dir");
        assert_eq!(
            shown(&list_dir(&root, "", false).unwrap()),
            ["src/", ".gitignore", "README.md"]
        );
        // A subfolder still minds the root's `.gitignore`.
        assert_eq!(
            shown(&list_dir(&root, "src", false).unwrap()),
            ["src/nested/", "src/main.rs"]
        );
        assert_eq!(
            shown(&list_dir(&root, "", true).unwrap()),
            [
                "src/",
                "target/ (ignored)",
                ".gitignore",
                "debug.log (ignored)",
                "README.md"
            ]
        );
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn stays_inside_the_folder() {
        let root = project("escape");
        assert!(list_dir(&root, "..", false).is_err());
        assert!(list_dir(&root, "src/../..", false).is_err());
        assert!(list_dir(&root, "README.md", false).is_err());
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn a_missing_folder_is_an_error() {
        assert!(list(Path::new("/definitely/not/here"), false).is_err());
    }
}
