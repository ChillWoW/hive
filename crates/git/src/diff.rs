//! A checkout's changes as one unified patch:
//! tracked changes from `git diff`, then each untracked file as a new one.

use std::path::Path;

use hive_proto::GitDiff;
use tokio::io::AsyncReadExt as _;
use tokio::process::Command;

use super::{command, current_branch, existing, git, run, spawn_error, toplevel, GitError};

/// The patch stops growing past this; the rest is left out ("partial").
const MAX_PATCH_BYTES: usize = 3 * 1024 * 1024;
/// What git diffs against before the first commit.
pub(crate) const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/// Past this a file's HEAD text isn't read (the editor's own limit).
const MAX_HEAD_TEXT: usize = 8 * 1024 * 1024;

/// What the editor's gutter compares `path` (relative to `cwd`) with: its
/// text at HEAD, with `\n` line endings and no BOM; `""` for a file git would
/// add (untracked or only staged, not ignored); `None` outside a checkout,
/// for an ignored file, or one that isn't text.
pub async fn head_text(cwd: &Path, path: &str) -> Result<Option<String>, GitError> {
    if !cwd.is_dir() || path.is_empty() || path.starts_with('-') {
        return Ok(None);
    }
    let inside = git(cwd, &["rev-parse", "--is-inside-work-tree"]).await?;
    if !inside.ok() || inside.stdout.trim() != "true" {
        return Ok(None);
    }
    // `./` makes the path relative to `cwd`, not the checkout's root.
    let spec = format!("HEAD:./{path}");
    let out = run(command(cwd, &["cat-file", "blob", &spec])).await?;
    if out.status.success() {
        let bytes = out.stdout;
        if bytes.len() > MAX_HEAD_TEXT || bytes.contains(&0) {
            return Ok(None);
        }
        let Ok(text) = String::from_utf8(bytes) else {
            return Ok(None);
        };
        let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
        return Ok(Some(text.replace("\r\n", "\n")));
    }
    // Not at HEAD: new, unless ignored (exit 0 = ignored, 1 = not).
    let ignored = git(cwd, &["check-ignore", "-q", "--", path]).await?;
    Ok((ignored.code == Some(1)).then(String::new))
}

/// `cwd`'s checkout against HEAD, or with `base` against `merge-base(base,
/// HEAD)`; `None` outside a checkout. Paths are relative to its root.
pub async fn diff(cwd: &Path, base: Option<&str>) -> Result<Option<GitDiff>, GitError> {
    let Some(root_text) = toplevel(cwd).await? else {
        return Ok(None);
    };
    let root = Path::new(&root_text);

    let head = git(root, &["rev-parse", "--verify", "-q", "HEAD"]).await?.line();
    let branch = current_branch(root).await?;

    let (against, merge_base) = match base {
        Some(base) => {
            let base = existing(base)?;
            if head.is_none() {
                return Err(GitError::Failed("There are no commits yet.".into()));
            }
            let Some(sha) = git(root, &["merge-base", base, "HEAD"]).await?.line() else {
                return Err(GitError::Failed(format!(
                    "“{base}” has no history in common with HEAD."
                )));
            };
            let short = sha.chars().take(7).collect();
            (sha, Some(short))
        }
        None => (head.unwrap_or_else(|| EMPTY_TREE.to_owned()), None),
    };

    let (mut patch, mut truncated) =
        read_patch(patch_command(root, &["--no-optional-locks"], &[&against])).await?;

    // Untracked files, without optional locks so this never takes the index
    // from an agent running git here.
    let status = git(
        root,
        &[
            "-c",
            "core.quotePath=false",
            "--no-optional-locks",
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=all",
        ],
    )
    .await?
    .checked()?;
    let mut untracked = untracked_paths(&status);
    untracked.sort();

    for path in untracked {
        let budget = MAX_PATCH_BYTES.saturating_sub(patch.len());
        if budget == 0 {
            truncated = true;
            break;
        }
        let full = root.join(&path);
        let Ok(meta) = tokio::fs::symlink_metadata(&full).await else {
            continue; // gone since
        };
        let section = if meta.is_dir() {
            // A nested repository: git keeps it whole, and so does this.
            binary_patch(&path)
        } else if meta.file_type().is_symlink() {
            let target = tokio::fs::read_link(&full)
                .await
                .map(|t| t.to_string_lossy().replace('\\', "/"))
                .unwrap_or_default();
            text_patch(&path, &target, "120000")
        } else if meta.len() as usize > budget {
            truncated = true;
            binary_patch(&path)
        } else {
            let Ok(bytes) = tokio::fs::read(&full).await else {
                continue;
            };
            if bytes.contains(&0) {
                binary_patch(&path)
            } else {
                text_patch(&path, &String::from_utf8_lossy(&bytes), "100644")
            }
        };
        if patch.len() + section.len() > MAX_PATCH_BYTES {
            truncated = true;
            break;
        }
        if !patch.is_empty() && !patch.ends_with('\n') {
            patch.push('\n');
        }
        patch.push_str(&section);
    }

    Ok(Some(GitDiff {
        root: root_text,
        branch,
        merge_base,
        patch,
        truncated,
    }))
}

/// `git diff` printing the patch from one tree-ish to another (or to the
/// working tree): paths unquoted, renames found. `options` go before `diff`.
pub(crate) fn patch_command(cwd: &Path, options: &[&str], revs: &[&str]) -> std::process::Command {
    let mut args = vec!["-c", "core.quotePath=false"];
    args.extend_from_slice(options);
    args.extend(["diff", "--no-ext-diff", "--no-color", "--find-renames", "--unified=3"]);
    args.extend_from_slice(revs);
    args.push("--");
    command(cwd, &args)
}

/// Runs a [`patch_command`], keeping at most [`MAX_PATCH_BYTES`] of the
/// patch and never ending on half a line: (patch, cut short).
pub(crate) async fn read_patch(cmd: std::process::Command) -> Result<(String, bool), GitError> {
    let (bytes, truncated) = capped(cmd, MAX_PATCH_BYTES).await?;
    let mut patch = String::from_utf8_lossy(&bytes).into_owned();
    if truncated {
        patch.truncate(patch.rfind('\n').map_or(0, |i| i + 1));
    }
    Ok((patch, truncated))
}

/// Runs a prepared git command (stdout and stderr piped), keeping at most
/// `cap` bytes of its output: (stdout, cut short).
pub(crate) async fn capped(
    cmd: std::process::Command,
    cap: usize,
) -> Result<(Vec<u8>, bool), GitError> {
    let mut cmd = Command::from(cmd);
    cmd.kill_on_drop(true);
    let mut child = cmd.spawn().map_err(spawn_error)?;
    let mut stdout = child.stdout.take().expect("piped stdout");
    let mut stderr = child.stderr.take().expect("piped stderr");
    // Read on its own, so a chatty stderr (CRLF warnings per file) can't
    // block git while stdout is read; it ends when git does.
    let errors = tokio::spawn(async move {
        let mut err = Vec::new();
        let _ = stderr.read_to_end(&mut err).await;
        err
    });
    let mut out = Vec::new();
    (&mut stdout)
        .take(cap as u64 + 1)
        .read_to_end(&mut out)
        .await
        .map_err(|e| GitError::Failed(e.to_string()))?;
    if out.len() > cap {
        out.truncate(cap);
        let _ = child.start_kill();
        let _ = child.wait().await;
        return Ok((out, true));
    }
    let err = errors.await.unwrap_or_default();
    let status = child
        .wait()
        .await
        .map_err(|e| GitError::Failed(e.to_string()))?;
    if !status.success() {
        let output = super::Output {
            code: status.code(),
            stdout: String::new(),
            stderr: String::from_utf8_lossy(&err).into_owned(),
        };
        return Err(output.error());
    }
    Ok((out, false))
}

/// The `??` entries of `status --porcelain=v1 -z`.
fn untracked_paths(status: &str) -> Vec<String> {
    let mut paths = Vec::new();
    let mut records = status.split('\0');
    while let Some(record) = records.next() {
        if record.len() < 4 {
            continue;
        }
        let (code, path) = record.split_at(3);
        // A rename or copy carries its old path as the next record.
        if code.starts_with('R') || code.starts_with('C') {
            records.next();
        }
        if code == "?? " {
            paths.push(path.to_owned());
        }
    }
    paths
}

/// An untracked file as git would show it once added.
fn text_patch(path: &str, content: &str, mode: &str) -> String {
    let mut lines: Vec<&str> = content.split('\n').collect();
    let ends_in_newline = lines.last() == Some(&"");
    if ends_in_newline {
        lines.pop();
    }
    let mut section = format!("diff --git a/{path} b/{path}\nnew file mode {mode}\n");
    if lines.is_empty() {
        return section;
    }
    section.push_str(&format!("--- /dev/null\n+++ b/{path}\n@@ -0,0 +1,{} @@\n", lines.len()));
    for line in &lines {
        section.push('+');
        section.push_str(line.strip_suffix('\r').unwrap_or(line));
        section.push('\n');
    }
    if !ends_in_newline {
        section.push_str("\\ No newline at end of file\n");
    }
    section
}

fn binary_patch(path: &str) -> String {
    format!(
        "diff --git a/{path} b/{path}\nnew file mode 100644\nBinary files /dev/null and b/{path} differ\n"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn untracked_entries_skip_rename_sources() {
        let status = "R  new.rs\0old.rs\0?? a b.txt\0 M src/x.rs\0?? dir/y\0";
        assert_eq!(untracked_paths(status), vec!["a b.txt", "dir/y"]);
    }

    #[test]
    fn untracked_text_patch() {
        assert_eq!(
            text_patch("a.txt", "one\ntwo\n", "100644"),
            "diff --git a/a.txt b/a.txt\nnew file mode 100644\n--- /dev/null\n+++ b/a.txt\n@@ -0,0 +1,2 @@\n+one\n+two\n"
        );
        assert!(text_patch("a.txt", "one", "100644").ends_with("+one\n\\ No newline at end of file\n"));
        assert_eq!(
            text_patch("e.txt", "", "100644"),
            "diff --git a/e.txt b/e.txt\nnew file mode 100644\n"
        );
    }
}
