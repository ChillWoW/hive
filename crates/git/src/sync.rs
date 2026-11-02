//! Bringing a branch level with its upstream: pull (fast-forward only) and
//! push, publishing a branch that has no upstream yet. Fetching is
//! `fetch_all` in `history.rs`.

use std::path::Path;
use std::time::Duration;

use super::{current_branch, git, GitError};

/// A remote asking for a password never answers (prompts are off).
const SYNC_TIMEOUT: Duration = Duration::from_secs(120);

async fn timed(cwd: &Path, args: &[&str], what: &str) -> Result<(), GitError> {
    match tokio::time::timeout(SYNC_TIMEOUT, git(cwd, args)).await {
        Ok(out) => out?.checked().map(drop),
        Err(_) => Err(GitError::Failed(format!("{what} took too long."))),
    }
}

/// The checked-out branch, refused on a detached HEAD.
async fn branch(cwd: &Path) -> Result<String, GitError> {
    current_branch(cwd)
        .await?
        .ok_or_else(|| GitError::Failed("No branch is checked out.".into()))
}

/// Fast-forwards the checked-out branch to its upstream (`git pull
/// --ff-only`); refused, with git's reason, when the two have diverged or a
/// local change would be overwritten.
pub async fn pull(cwd: &Path) -> Result<(), GitError> {
    branch(cwd).await?;
    timed(cwd, &["pull", "--ff-only", "--quiet"], "Pulling").await
}

/// Pushes the checked-out branch to its upstream; one without an upstream is
/// published to `origin` under its own name and tracks it from then on.
pub async fn push(cwd: &Path) -> Result<(), GitError> {
    let name = branch(cwd).await?;
    let upstream = git(cwd, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])
        .await?
        .line();
    if upstream.is_some() {
        return timed(cwd, &["push", "--quiet"], "Pushing").await;
    }
    if git(cwd, &["remote", "get-url", "origin"]).await?.line().is_none() {
        return Err(GitError::Failed("There's no remote named origin to publish to.".into()));
    }
    let refspec = format!("HEAD:refs/heads/{name}");
    timed(cwd, &["push", "--quiet", "--set-upstream", "origin", &refspec], "Publishing").await
}

#[cfg(test)]
mod tests {
    use super::super::{repo, test_repo};
    use super::*;

    async fn ok(cwd: &Path, args: &[&str]) {
        assert!(git(cwd, args).await.unwrap().ok(), "git {args:?}");
    }

    /// `main` cloned from a bare `origin`: (temp dir, origin, clone).
    async fn fixture() -> Option<(tempfile::TempDir, std::path::PathBuf, std::path::PathBuf)> {
        let dir = tempfile::tempdir().unwrap();
        let seed = dir.path().join("seed");
        std::fs::create_dir(&seed).unwrap();
        test_repo(&seed, "a").await?;
        let origin = dir.path().join("origin.git");
        let clone = dir.path().join("clone");
        ok(dir.path(), &["clone", "-q", "--bare", "seed", "origin.git"]).await;
        ok(dir.path(), &["clone", "-q", "origin.git", "clone"]).await;
        for args in [
            &["config", "user.email", "hive@example.com"][..],
            &["config", "user.name", "Hive"],
            &["config", "commit.gpgsign", "false"],
        ] {
            ok(&clone, args).await;
        }
        Some((dir, origin, clone))
    }

    fn current(repo: &hive_proto::GitRepo) -> &hive_proto::GitBranch {
        repo.branches.iter().find(|b| b.current).unwrap()
    }

    #[tokio::test]
    async fn publishes_pushes_and_pulls() {
        let Some((dir, origin, clone)) = fixture().await else { return };

        // A new branch has no upstream: push publishes it and tracks it.
        ok(&clone, &["switch", "-q", "-c", "topic"]).await;
        std::fs::write(clone.join("b.txt"), "b").unwrap();
        ok(&clone, &["add", "."]).await;
        ok(&clone, &["commit", "-q", "-m", "b"]).await;
        push(&clone).await.unwrap();
        let r = repo(&clone).await.unwrap().unwrap();
        assert_eq!(current(&r).upstream.as_deref(), Some("origin/topic"));
        assert_eq!(current(&r).ahead, 0);
        assert!(git(&origin, &["rev-parse", "--verify", "-q", "topic"]).await.unwrap().ok());

        // Someone else pushes to it; fetching shows it behind, pulling catches up.
        let other = dir.path().join("other");
        ok(dir.path(), &["clone", "-q", "-b", "topic", "origin.git", "other"]).await;
        ok(&other, &["config", "user.email", "hive@example.com"]).await;
        ok(&other, &["config", "user.name", "Hive"]).await;
        ok(&other, &["config", "commit.gpgsign", "false"]).await;
        std::fs::write(other.join("c.txt"), "c").unwrap();
        ok(&other, &["add", "."]).await;
        ok(&other, &["commit", "-q", "-m", "c"]).await;
        ok(&other, &["push", "-q"]).await;

        crate::fetch_all(&clone).await.unwrap();
        assert_eq!(current(&repo(&clone).await.unwrap().unwrap()).behind, 1);
        pull(&clone).await.unwrap();
        assert_eq!(current(&repo(&clone).await.unwrap().unwrap()).behind, 0);
        assert!(clone.join("c.txt").exists());

        // A commit here goes up with a plain push.
        std::fs::write(clone.join("d.txt"), "d").unwrap();
        ok(&clone, &["add", "."]).await;
        ok(&clone, &["commit", "-q", "-m", "d"]).await;
        assert_eq!(current(&repo(&clone).await.unwrap().unwrap()).ahead, 1);
        push(&clone).await.unwrap();
        assert_eq!(current(&repo(&clone).await.unwrap().unwrap()).ahead, 0);
    }

    #[tokio::test]
    async fn refuses_a_detached_head() {
        let Some((_dir, _origin, clone)) = fixture().await else { return };
        ok(&clone, &["switch", "-q", "--detach"]).await;
        assert!(pull(&clone).await.is_err());
        assert!(push(&clone).await.is_err());
    }
}
