//! A folder's `git status`, path by path, for the file panel's tree.

use std::path::Path;

use hive_proto::{GitFileState, GitFileStatus};

use crate::{git, GitError};

/// Every changed, untracked or conflicted path under `cwd` (relative to it);
/// `None` when `cwd` isn't in a checkout. An untracked folder comes as one
/// entry ending in `/`, not its files; `""` when `cwd` is inside one. Ignored
/// paths are left out.
pub async fn status(cwd: &Path) -> Result<Option<Vec<GitFileStatus>>, GitError> {
    if !cwd.is_dir() {
        return Ok(None);
    }
    // Where `cwd` is in its checkout: status paths are relative to the root.
    let prefix = git(cwd, &["rev-parse", "--show-prefix"]).await?;
    if !prefix.ok() {
        if prefix.stderr.contains("not a git repository") {
            return Ok(None);
        }
        return Err(prefix.error());
    }
    let prefix = prefix.stdout.trim_end_matches(['\r', '\n']).to_owned();
    // Without optional locks, so it never holds the index while an agent
    // runs git here.
    let out = git(
        cwd,
        &[
            "--no-optional-locks",
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=normal",
            "--",
            ".",
        ],
    )
    .await?
    .checked()?;
    Ok(Some(parse(&out, &prefix)))
}

/// `git status --porcelain -z` → paths under `prefix`, made relative to it.
fn parse(out: &str, prefix: &str) -> Vec<GitFileStatus> {
    let mut files = Vec::new();
    let mut fields = out.split('\0');
    while let Some(field) = fields.next() {
        let code = field.as_bytes();
        if code.len() < 4 || code[2] != b' ' {
            continue;
        }
        let (x, y) = (code[0], code[1]);
        // A rename or copy is followed by the path it came from.
        if matches!(x, b'R' | b'C') || matches!(y, b'R' | b'C') {
            fields.next();
        }
        let Some(state) = state_of(x, y) else {
            continue;
        };
        let path = &field[3..];
        let path = match path.strip_prefix(prefix) {
            Some(rest) if !rest.is_empty() => rest,
            // The folder itself is in an untracked one: all of it is.
            _ if path.ends_with('/') && prefix.starts_with(path) => "",
            _ => continue,
        };
        files.push(GitFileStatus {
            path: path.to_owned(),
            state,
        });
    }
    files
}

/// The state a path's index (`x`) and worktree (`y`) codes show, in Zed's
/// order: conflict, untracked, then the worktree's change before the index's.
fn state_of(x: u8, y: u8) -> Option<GitFileState> {
    use GitFileState::*;
    Some(match (x, y) {
        (b'D', b'D') | (b'A', b'A') | (b'U', _) | (_, b'U') => Conflict,
        (b'?', b'?') => Untracked,
        (_, b'D') => Deleted,
        (_, b'M' | b'T' | b'R' | b'C') => Modified,
        (b'D', _) => Deleted,
        (b'M' | b'T' | b'R' | b'C', _) => Modified,
        (b'A', _) | (_, b'A') => Added,
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_repo;

    fn st(path: &str, state: GitFileState) -> GitFileStatus {
        GitFileStatus {
            path: path.into(),
            state,
        }
    }

    #[test]
    fn parses_porcelain() {
        let out = "UU both.rs\0?? new/\0 M src/a.rs\0R  src/b.rs\0src/old.rs\0A  src/c.rs\0 D d.rs\0MM src/e.rs\0";
        assert_eq!(
            parse(out, ""),
            vec![
                st("both.rs", GitFileState::Conflict),
                st("new/", GitFileState::Untracked),
                st("src/a.rs", GitFileState::Modified),
                st("src/b.rs", GitFileState::Modified),
                st("src/c.rs", GitFileState::Added),
                st("d.rs", GitFileState::Deleted),
                st("src/e.rs", GitFileState::Modified),
            ]
        );
        assert_eq!(
            parse(out, "src/"),
            vec![
                st("a.rs", GitFileState::Modified),
                st("b.rs", GitFileState::Modified),
                st("c.rs", GitFileState::Added),
                st("e.rs", GitFileState::Modified),
            ]
        );
    }

    #[tokio::test]
    async fn reads_a_checkout() {
        let dir = tempfile::tempdir().unwrap();
        if test_repo(dir.path(), "a").await.is_none() {
            return;
        }
        let root = dir.path();
        std::fs::write(root.join("a.txt"), "changed").unwrap();
        std::fs::create_dir_all(root.join("sub/fresh")).unwrap();
        std::fs::write(root.join("sub/fresh/x.txt"), "x").unwrap();
        std::fs::write(root.join("sub/y.txt"), "y").unwrap();

        let mut all = status(root).await.unwrap().unwrap();
        all.sort_by(|a, b| a.path.cmp(&b.path));
        assert_eq!(
            all,
            vec![
                st("a.txt", GitFileState::Modified),
                st("sub/", GitFileState::Untracked),
            ]
        );

        // Inside the untracked folder: all of it is.
        let sub = status(&root.join("sub")).await.unwrap().unwrap();
        assert_eq!(sub, vec![st("", GitFileState::Untracked)]);
    }
}
