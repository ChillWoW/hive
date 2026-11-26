//! outcode-git — a project folder's branches, over the `git` the user has
//! installed: list them, switch, branch off one, delete one.

use std::path::Path;
use std::process::Stdio;

use outcode_proto::{GitBranch, GitRepo};
use tokio::process::Command;

#[derive(Debug, thiserror::Error)]
pub enum GitError {
    #[error("Git isn't installed, or isn't on PATH.")]
    NotInstalled,
    #[error("“{0}” isn't a valid branch name.")]
    InvalidName(String),
    #[error("“{0}” is checked out; switch to another branch first.")]
    CurrentBranch(String),
    /// What git said, minus its `error:` / `fatal:` prefixes.
    #[error("{0}")]
    Failed(String),
}

struct Output {
    code: Option<i32>,
    stdout: String,
    stderr: String,
}

impl Output {
    fn ok(&self) -> bool {
        self.code == Some(0)
    }

    fn error(&self) -> GitError {
        let text = self
            .stderr
            .lines()
            .map(|line| {
                let line = line.trim();
                ["error: ", "fatal: "]
                    .iter()
                    .find_map(|p| line.strip_prefix(p))
                    .unwrap_or(line)
            })
            // The hints after an error are about the git CLI, not Outcode.
            .filter(|line| !line.is_empty() && !line.starts_with("hint:"))
            .collect::<Vec<_>>()
            .join("\n");
        GitError::Failed(if text.is_empty() {
            "Git failed without saying why.".into()
        } else {
            text
        })
    }

    /// Stdout, or the error git printed.
    fn checked(self) -> Result<String, GitError> {
        if self.ok() { Ok(self.stdout) } else { Err(self.error()) }
    }

    /// Stdout, trimmed, when git succeeded and printed something.
    fn line(&self) -> Option<String> {
        let text = self.stdout.trim();
        (self.ok() && !text.is_empty()).then(|| text.to_owned())
    }
}

async fn git(cwd: &Path, args: &[&str]) -> Result<Output, GitError> {
    let mut cmd = Command::new("git");
    cmd.args(args)
        .current_dir(cwd)
        // Messages in English (they're matched on), and never a prompt.
        .env("LC_ALL", "C")
        .env("GIT_TERMINAL_PROMPT", "0")
        // Reads never rewrite the index under an agent running git here.
        .env("GIT_OPTIONAL_LOCKS", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    let out = cmd.output().await.map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => GitError::NotInstalled,
        _ => GitError::Failed(e.to_string()),
    })?;
    Ok(Output {
        code: out.status.code(),
        stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
    })
}

/// The top folder of the checkout `cwd` is in, as git prints it; `None` when
/// it isn't in one (or doesn't exist).
async fn toplevel(cwd: &Path) -> Result<Option<String>, GitError> {
    if !cwd.is_dir() {
        return Ok(None);
    }
    let top = git(cwd, &["rev-parse", "--show-toplevel"]).await?;
    if !top.ok() {
        if top.stderr.contains("not a git repository") {
            return Ok(None);
        }
        return Err(top.error());
    }
    Ok(Some(top.stdout.trim().to_owned()))
}

/// The checked-out branch's short name; `None` when HEAD is detached.
async fn current_branch(cwd: &Path) -> Result<Option<String>, GitError> {
    Ok(git(cwd, &["symbolic-ref", "-q", "--short", "HEAD"]).await?.line())
}

/// The checkout `cwd` is in; `None` when it isn't in one (or doesn't exist).
pub async fn repo(cwd: &Path) -> Result<Option<GitRepo>, GitError> {
    let Some(root) = toplevel(cwd).await? else {
        return Ok(None);
    };
    // Exit 1: detached.
    let head = git(cwd, &["symbolic-ref", "-q", "HEAD"]).await?;
    let branch = match head.code {
        Some(0) => {
            let full = head.stdout.trim();
            Some(full.strip_prefix("refs/heads/").unwrap_or(full).to_owned())
        }
        Some(1) => None,
        _ => return Err(head.error()),
    };
    // Fails before the first commit.
    let commit = git(cwd, &["rev-parse", "--short", "HEAD"]).await?.line();

    let list = git(
        cwd,
        &[
            "for-each-ref",
            "--sort=-committerdate",
            "--format=%(refname)%00%(committerdate:unix)%00%(worktreepath)",
            "refs/heads",
        ],
    )
    .await?
    .checked()?;
    let merged = if commit.is_some() {
        git(cwd, &["for-each-ref", "--merged=HEAD", "--format=%(refname)", "refs/heads"])
            .await?
            .checked()
            .unwrap_or_default()
    } else {
        String::new()
    };
    let merged: Vec<&str> = merged.lines().collect();

    let branches = list
        .lines()
        .filter_map(|line| {
            let mut fields = line.split('\0');
            let refname = fields.next()?;
            let name = refname.strip_prefix("refs/heads/")?.to_owned();
            let committed_at = fields
                .next()
                .and_then(|s| s.trim().parse::<u64>().ok())
                .map(|secs| secs * 1000);
            let worktree = fields
                .next()
                .filter(|p| !p.is_empty() && !same_path(p, &root))
                .map(str::to_owned);
            Some(GitBranch {
                current: branch.as_deref() == Some(name.as_str()),
                merged: merged.contains(&refname),
                name,
                committed_at,
                worktree,
            })
        })
        .collect();

    Ok(Some(GitRepo {
        root,
        branch,
        commit,
        branches,
    }))
}

/// Git prints paths with forward slashes; Windows drives come in either case.
fn same_path(a: &str, b: &str) -> bool {
    let norm = |p: &str| {
        let p = p.replace('\\', "/");
        let p = p.trim_end_matches('/');
        if cfg!(windows) { p.to_lowercase() } else { p.to_owned() }
    };
    norm(a) == norm(b)
}

/// A name git accepts for a new branch.
async fn check_name(cwd: &Path, name: &str) -> Result<(), GitError> {
    let invalid = || GitError::InvalidName(name.to_owned());
    if name.is_empty() || name.starts_with('-') || name.trim() != name {
        return Err(invalid());
    }
    let out = git(cwd, &["check-ref-format", "--branch", name]).await?;
    if out.ok() { Ok(()) } else { Err(invalid()) }
}

/// An existing branch's name, never read as an option.
fn existing(name: &str) -> Result<&str, GitError> {
    if name.is_empty() || name.starts_with('-') {
        Err(GitError::InvalidName(name.to_owned()))
    } else {
        Ok(name)
    }
}

/// Checks out `name`. Git refuses when local changes would be overwritten.
pub async fn switch(cwd: &Path, name: &str) -> Result<(), GitError> {
    git(cwd, &["switch", existing(name)?]).await?.checked()?;
    Ok(())
}

/// Makes branch `name` at `from` and checks it out.
pub async fn create(cwd: &Path, name: &str, from: &str) -> Result<(), GitError> {
    check_name(cwd, name).await?;
    git(cwd, &["switch", "--no-track", "-c", name, existing(from)?])
        .await?
        .checked()?;
    Ok(())
}

/// Deletes branch `name`, merged or not; never the checked-out one.
pub async fn delete(cwd: &Path, name: &str) -> Result<(), GitError> {
    let name = existing(name)?;
    if current_branch(cwd).await?.as_deref() == Some(name) {
        return Err(GitError::CurrentBranch(name.to_owned()));
    }
    git(cwd, &["branch", "-D", "--", name]).await?.checked()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A repository with one commit on `main`; `None` when git isn't installed.
    async fn fixture() -> Option<tempfile::TempDir> {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path();
        for args in [
            &["init", "-q", "-b", "main"][..],
            &["config", "user.email", "test@example.com"],
            &["config", "user.name", "Test"],
            &["config", "commit.gpgsign", "false"],
            &["commit", "-q", "--allow-empty", "-m", "first"],
        ] {
            if !git(path, args).await.ok()?.ok() {
                return None;
            }
        }
        Some(dir)
    }

    #[tokio::test]
    async fn a_plain_folder_is_no_repo() {
        let dir = tempfile::tempdir().unwrap();
        if git(dir.path(), &["--version"]).await.is_err() {
            return;
        }
        assert_eq!(repo(dir.path()).await.unwrap(), None);
    }

    #[tokio::test]
    async fn lists_creates_switches_and_deletes() {
        let Some(dir) = fixture().await else { return };
        let path = dir.path();

        let r = repo(path).await.unwrap().unwrap();
        assert_eq!(r.branch.as_deref(), Some("main"));
        assert_eq!(r.branches.len(), 1);
        assert!(r.branches[0].current);

        create(path, "feat/x", "main").await.unwrap();
        let r = repo(path).await.unwrap().unwrap();
        assert_eq!(r.branch.as_deref(), Some("feat/x"));
        assert_eq!(r.branches.len(), 2);
        assert!(r.branches.iter().all(|b| b.merged));

        assert!(matches!(delete(path, "feat/x").await, Err(GitError::CurrentBranch(_))));
        switch(path, "main").await.unwrap();
        delete(path, "feat/x").await.unwrap();
        let r = repo(path).await.unwrap().unwrap();
        assert_eq!(r.branches.len(), 1);
    }

    #[tokio::test]
    async fn refuses_bad_names() {
        let Some(dir) = fixture().await else { return };
        let path = dir.path();
        for name in ["", "-x", " a", "a..b", "a b"] {
            assert!(matches!(
                create(path, name, "main").await,
                Err(GitError::InvalidName(_))
            ));
        }
        assert!(matches!(switch(path, "--orphan").await, Err(GitError::InvalidName(_))));
    }
}
