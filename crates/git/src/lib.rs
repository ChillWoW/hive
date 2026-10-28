//! hive-git — a project folder's branches, over the `git` the user has
//! installed: list them, switch, branch off one, delete one.

use std::path::Path;
use std::process::Stdio;

use hive_proto::{GitBranch, GitRepo};
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
            // The hints after an error are about the git CLI, not Hive.
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
        if self.ok() {
            Ok(self.stdout)
        } else {
            Err(self.error())
        }
    }
}

async fn git(cwd: &Path, args: &[&str]) -> Result<Output, GitError> {
    let mut cmd = Command::new("git");
    cmd.args(args)
        .current_dir(cwd)
        // Messages in English (they're matched on), and never a prompt.
        .env("LC_ALL", "C")
        .env("GIT_TERMINAL_PROMPT", "0")
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

/// The checkout `cwd` is in; `None` when it isn't in one (or doesn't exist).
pub async fn repo(cwd: &Path) -> Result<Option<GitRepo>, GitError> {
    if !cwd.is_dir() {
        return Ok(None);
    }
    // Exit 1: detached; 128: not a repository (or one git won't open).
    let head = git(cwd, &["symbolic-ref", "-q", "HEAD"]).await?;
    let branch = match head.code {
        Some(0) => Some(
            head.stdout
                .trim()
                .strip_prefix("refs/heads/")
                .unwrap_or(head.stdout.trim())
                .to_owned(),
        ),
        Some(1) => None,
        _ if head.stderr.contains("not a git repository") => return Ok(None),
        _ => return Err(head.error()),
    };
    // Fails before the first commit.
    let commit = git(cwd, &["rev-parse", "--short", "HEAD"]).await?;
    let commit = commit.ok().then(|| commit.stdout.trim().to_owned());

    let list = git(
        cwd,
        &[
            "for-each-ref",
            "--sort=-committerdate",
            "--format=%(refname)%00%(upstream:short)%00%(upstream:track,nobracket)%00%(committerdate:unix)%00%(subject)",
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
            let upstream = fields.next().filter(|s| !s.is_empty()).map(str::to_owned);
            let (ahead, behind) = parse_track(fields.next().unwrap_or(""));
            let committed_at = fields
                .next()
                .and_then(|s| s.trim().parse::<u64>().ok())
                .map(|secs| secs * 1000);
            let subject = fields.next().filter(|s| !s.is_empty()).map(str::to_owned);
            Some(GitBranch {
                current: branch.as_deref() == Some(name.as_str()),
                merged: merged.contains(&refname),
                name,
                upstream,
                ahead,
                behind,
                committed_at,
                subject,
            })
        })
        .collect();

    Ok(Some(GitRepo {
        branch,
        commit,
        branches,
    }))
}

/// `"ahead 2, behind 1"` → (2, 1); `"gone"` or nothing → (0, 0).
fn parse_track(track: &str) -> (u32, u32) {
    let mut ahead = 0;
    let mut behind = 0;
    for part in track.split(',') {
        let mut words = part.split_whitespace();
        match (words.next(), words.next().and_then(|n| n.parse().ok())) {
            (Some("ahead"), Some(n)) => ahead = n,
            (Some("behind"), Some(n)) => behind = n,
            _ => {}
        }
    }
    (ahead, behind)
}

/// A name git accepts for a new branch.
async fn check_name(cwd: &Path, name: &str) -> Result<(), GitError> {
    let invalid = || GitError::InvalidName(name.to_owned());
    if name.is_empty() || name.starts_with('-') || name.trim() != name {
        return Err(invalid());
    }
    let out = git(cwd, &["check-ref-format", "--branch", name]).await?;
    if out.ok() {
        Ok(())
    } else {
        Err(invalid())
    }
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
    let head = git(cwd, &["symbolic-ref", "-q", "--short", "HEAD"]).await?;
    if head.ok() && head.stdout.trim() == name {
        return Err(GitError::CurrentBranch(name.to_owned()));
    }
    git(cwd, &["branch", "-D", "--", name]).await?.checked()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A repository with one commit on `main`; `None` without git.
    async fn fixture() -> Option<tempfile::TempDir> {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path();
        let run = |args: &'static [&'static str]| async move {
            git(path, args).await.ok().filter(|o| o.ok())
        };
        run(&["init", "-q", "-b", "main"]).await?;
        run(&["config", "user.email", "hive@example.com"]).await?;
        run(&["config", "user.name", "Hive"]).await?;
        run(&["config", "commit.gpgsign", "false"]).await?;
        std::fs::write(path.join("a.txt"), "a").unwrap();
        run(&["add", "."]).await?;
        run(&["commit", "-q", "-m", "first"]).await?;
        Some(dir)
    }

    #[tokio::test]
    async fn a_plain_folder_is_no_repo() {
        let dir = tempfile::tempdir().unwrap();
        // Only meaningful when the temp dir isn't inside a checkout itself.
        if git(dir.path(), &["rev-parse", "--git-dir"]).await.is_ok_and(|o| o.ok()) {
            return;
        }
        assert_eq!(repo(dir.path()).await.unwrap(), None);
        assert_eq!(repo(Path::new("/definitely/not/here")).await.unwrap(), None);
    }

    #[tokio::test]
    async fn lists_creates_switches_and_deletes() {
        let Some(dir) = fixture().await else { return };
        let path = dir.path();

        let r = repo(path).await.unwrap().unwrap();
        assert_eq!(r.branch.as_deref(), Some("main"));
        assert!(r.commit.is_some());
        assert_eq!(r.branches.len(), 1);
        assert!(r.branches[0].current && r.branches[0].merged);
        assert_eq!(r.branches[0].subject.as_deref(), Some("first"));

        create(path, "feat/x", "main").await.unwrap();
        let r = repo(path).await.unwrap().unwrap();
        assert_eq!(r.branch.as_deref(), Some("feat/x"));
        assert_eq!(r.branches.len(), 2);

        // Not the checked-out one.
        assert!(matches!(
            delete(path, "feat/x").await,
            Err(GitError::CurrentBranch(_))
        ));

        // An unmerged commit on feat/x.
        std::fs::write(path.join("b.txt"), "b").unwrap();
        git(path, &["add", "."]).await.unwrap();
        git(path, &["commit", "-q", "-m", "second"]).await.unwrap();

        switch(path, "main").await.unwrap();
        let r = repo(path).await.unwrap().unwrap();
        let feat = r.branches.iter().find(|b| b.name == "feat/x").unwrap();
        assert!(!feat.merged && !feat.current);

        delete(path, "feat/x").await.unwrap();
        let r = repo(path).await.unwrap().unwrap();
        assert_eq!(r.branches.len(), 1);
    }

    #[tokio::test]
    async fn refuses_bad_names() {
        let Some(dir) = fixture().await else { return };
        let path = dir.path();
        for name in ["", "-x", "a..b", "has space", "end.lock"] {
            assert!(
                matches!(create(path, name, "main").await, Err(GitError::InvalidName(_))),
                "{name:?}"
            );
        }
        assert!(matches!(switch(path, "--orphan").await, Err(GitError::InvalidName(_))));
        // Git's own message for a missing branch comes through.
        assert!(matches!(switch(path, "nope").await, Err(GitError::Failed(_))));
        // An existing name.
        assert!(matches!(create(path, "main", "main").await, Err(GitError::Failed(_))));
    }

    #[test]
    fn parses_tracking() {
        assert_eq!(parse_track(""), (0, 0));
        assert_eq!(parse_track("gone"), (0, 0));
        assert_eq!(parse_track("ahead 2"), (2, 0));
        assert_eq!(parse_track("ahead 2, behind 11"), (2, 11));
    }
}
