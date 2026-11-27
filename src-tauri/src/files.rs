//! Files the user opens from the app, and a chat folder's files for the
//! composer's `@` menu and the file panel: every file and folder that
//! `.gitignore` (and `.ignore`) doesn't hide, dotfiles included, `.git`
//! never. The file panel can ask for the ignored ones too, and renames and
//! deletes (to the system's trash) what it lists.

use std::collections::HashSet;
use std::path::{Component, Path};

use outcode_proto::WorkspaceEntry;
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

use crate::editor::resolve;

/// Past this the walk stops; ranking happens in the webview.
const MAX_ENTRIES: usize = 50_000;

/// Opens `path` in the system's default app for it.
#[tauri::command]
pub fn file_open(app: AppHandle, path: String) -> Result<(), String> {
    if !std::path::Path::new(&path).is_file() {
        return Err(format!("{path} doesn't exist"));
    }
    app.opener()
        .open_path(&path, None::<&str>)
        .map_err(|e| e.to_string())
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

/// Shallowest first, folders before files, then by name: what the menu
/// shows before anything is typed, and each folder's order in the tree.
fn sort(entries: &mut [WorkspaceEntry]) {
    entries.sort_by_cached_key(|entry| {
        (
            entry.path.matches('/').count(),
            !entry.dir,
            entry.path.to_lowercase(),
        )
    });
}

/// `folder`'s children under `root` that aren't in `known`, as ignored
/// entries; `.git` never.
fn ignored_in(root: &Path, folder: &str, known: &HashSet<&str>) -> Vec<WorkspaceEntry> {
    let Ok(read) = std::fs::read_dir(root.join(folder)) else {
        return Vec::new();
    };
    read.flatten()
        .filter_map(|child| {
            let name = child.file_name().to_string_lossy().into_owned();
            if name == ".git" {
                return None;
            }
            let path = if folder.is_empty() { name } else { format!("{folder}/{name}") };
            if known.contains(path.as_str()) {
                return None;
            }
            let dir = child.path().is_dir();
            Some(WorkspaceEntry { path, dir, ignored: true })
        })
        .collect()
}

/// What `.gitignore` doesn't hide under `root`; with `ignored`, also what it
/// hides right inside each listed folder (not walked into: `list_folder`
/// lists one once it's opened).
fn list(root: &Path, ignored: bool) -> Result<Vec<WorkspaceEntry>, String> {
    if !root.is_dir() {
        return Err(format!("{} is not a folder", root.display()));
    }
    let walk = ignore::WalkBuilder::new(root)
        .hidden(false)
        // A folder outside a checkout still means its `.gitignore`.
        .require_git(false)
        .follow_links(false)
        .filter_entry(|entry| entry.file_name() != ".git")
        .build();

    let mut entries = Vec::new();
    let mut truncated = false;
    for entry in walk {
        let Ok(entry) = entry else { continue };
        if entry.depth() == 0 {
            continue;
        }
        let (Some(path), Some(dir)) = (relative(root, entry.path()), is_dir(&entry)) else {
            continue;
        };
        entries.push(WorkspaceEntry { path, dir, ignored: false });
        if entries.len() >= MAX_ENTRIES {
            truncated = true;
            break;
        }
    }

    // Past the cap, what wasn't walked would pass for ignored.
    if ignored && !truncated {
        let known: HashSet<&str> = entries.iter().map(|e| e.path.as_str()).collect();
        // A linked folder wasn't walked into, so its children aren't ignored.
        let folders = std::iter::once("").chain(
            entries
                .iter()
                .filter(|e| e.dir && !root.join(&e.path).is_symlink())
                .map(|e| e.path.as_str()),
        );
        let hidden: Vec<_> = folders.flat_map(|f| ignored_in(root, f, &known)).collect();
        entries.extend(hidden);
    }

    sort(&mut entries);
    Ok(entries)
}

/// Every file and folder under `cwd` that `.gitignore` doesn't hide,
/// shallowest first; with `ignored`, the ignored ones right inside them too.
#[tauri::command]
pub async fn list_files(cwd: String, ignored: Option<bool>) -> Result<Vec<WorkspaceEntry>, String> {
    let ignored = ignored.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || list(Path::new(&cwd), ignored))
        .await
        .map_err(|e| e.to_string())?
}

/// `path`'s children under `root`, all ignored (it's an ignored folder the
/// file panel opened), folders first.
fn list_one(root: &Path, path: &str) -> Result<Vec<WorkspaceEntry>, String> {
    if !Path::new(path).components().all(|c| matches!(c, Component::Normal(_))) {
        return Err(format!("{path} isn't inside the folder"));
    }
    let mut entries = ignored_in(root, path, &HashSet::new());
    sort(&mut entries);
    Ok(entries)
}

/// What's right inside `path` (relative to `cwd`), every entry counted as
/// ignored; for opening an ignored folder in the file panel.
#[tauri::command]
pub async fn list_folder(cwd: String, path: String) -> Result<Vec<WorkspaceEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || list_one(Path::new(&cwd), &path))
        .await
        .map_err(|e| e.to_string())?
}

/// Whether both paths name one file, as `a.txt` and `A.txt` do where case doesn't count.
fn same_file(a: &Path, b: &Path) -> bool {
    matches!((a.canonicalize(), b.canonicalize()), (Ok(a), Ok(b)) if a == b)
}

fn rename(source: &Path, target: &Path) -> Result<(), String> {
    if std::fs::symlink_metadata(source).is_err() {
        return Err(format!("{} doesn't exist", source.display()));
    }
    // A rename would replace what's there.
    if std::fs::symlink_metadata(target).is_ok() && !same_file(source, target) {
        let name = target.file_name().unwrap_or_default().to_string_lossy();
        return Err(format!("{name} already exists"));
    }
    std::fs::rename(source, target).map_err(|e| e.to_string())
}

/// Renames the file or folder `from` to `to` (both relative to `cwd`);
/// refused when `to` is taken.
#[tauri::command]
pub async fn rename_path(cwd: String, from: String, to: String) -> Result<(), String> {
    let (source, target) = (resolve(&cwd, &from)?, resolve(&cwd, &to)?);
    tauri::async_runtime::spawn_blocking(move || rename(&source, &target))
        .await
        .map_err(|e| e.to_string())?
}

/// Moves the file or folder `path` (relative to `cwd`) to the system's trash.
#[tauri::command]
pub async fn trash_path(cwd: String, path: String) -> Result<(), String> {
    let target = resolve(&cwd, &path)?;
    tauri::async_runtime::spawn_blocking(move || {
        if std::fs::symlink_metadata(&target).is_err() {
            return Err(format!("{} doesn't exist", target.display()));
        }
        trash::delete(&target).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renames_unless_taken() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        std::fs::write(root.join("a.txt"), "a").unwrap();
        std::fs::write(root.join("b.txt"), "b").unwrap();

        assert!(rename(&root.join("a.txt"), &root.join("b.txt")).is_err());
        assert!(rename(&root.join("gone.txt"), &root.join("c.txt")).is_err());
        rename(&root.join("a.txt"), &root.join("c.txt")).unwrap();
        assert_eq!(std::fs::read_to_string(root.join("c.txt")).unwrap(), "a");
        assert_eq!(std::fs::read_to_string(root.join("b.txt")).unwrap(), "b");
    }

    #[test]
    fn lists_what_git_would_track() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::write(root.join(".git/HEAD"), "ref").unwrap();
        std::fs::create_dir_all(root.join("src/nested")).unwrap();
        std::fs::create_dir_all(root.join("target/debug")).unwrap();
        std::fs::write(root.join(".gitignore"), "target/\n*.log\n").unwrap();
        std::fs::write(root.join("README.md"), "").unwrap();
        std::fs::write(root.join("debug.log"), "").unwrap();
        std::fs::write(root.join("src/nested/a.rs"), "").unwrap();

        let paths = |ignored| -> Vec<_> {
            list(root, ignored)
                .unwrap()
                .into_iter()
                .map(|e| {
                    let mark = if e.ignored { "!" } else { "" };
                    let slash = if e.dir { "/" } else { "" };
                    format!("{mark}{}{slash}", e.path)
                })
                .collect()
        };
        assert_eq!(
            paths(false),
            ["src/", ".gitignore", "README.md", "src/nested/", "src/nested/a.rs"]
        );
        assert_eq!(
            paths(true),
            [
                "src/",
                "!target/",
                ".gitignore",
                "!debug.log",
                "README.md",
                "src/nested/",
                "src/nested/a.rs"
            ]
        );

        let inside: Vec<_> = list_one(root, "target").unwrap().into_iter().map(|e| e.path).collect();
        assert_eq!(inside, ["target/debug"]);
        assert!(list_one(root, "../x").is_err());
    }
}
