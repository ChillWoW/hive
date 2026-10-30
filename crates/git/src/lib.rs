//! hive-git — a project folder's branches and Hive's worktrees, over the
//! `git` the user has installed: list branches, switch, branch off one,
//! delete one; add, restore and remove a chat's worktree; diff a checkout,
//! or snapshot it when a turn starts and diff that turn; page, search and
//! fetch its history.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use hive_proto::{GitBranch, GitRepo, Worktree};
use tokio::process::Command;

mod diff;
mod history;
mod turn;
pub use diff::{diff, MAX_PATCH_BYTES};
pub use history::{
    commit_diff, fetch_all, github_remote, history, history_matches, search_history,
    HISTORY_DEFAULT_LIMIT, HISTORY_MAX_LIMIT,
};
pub use turn::{snapshot_tree, sweep_turn_snapshots, turn_diff, TreeSnapshot};

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

fn command<S: AsRef<std::ffi::OsStr>>(cwd: &Path, args: &[S]) -> std::process::Command {
    let mut cmd = std::process::Command::new("git");
    cmd.args(args)
        .current_dir(cwd)
        // Messages in English (they're matched on), and never a prompt.
        .env("LC_ALL", "C")
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt as _;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd
}

fn output(out: std::io::Result<std::process::Output>) -> Result<Output, GitError> {
    let out = out.map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => GitError::NotInstalled,
        _ => GitError::Failed(e.to_string()),
    })?;
    Ok(Output {
        code: out.status.code(),
        stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
    })
}

async fn git(cwd: &Path, args: &[&str]) -> Result<Output, GitError> {
    let mut cmd = Command::from(command(cwd, args));
    cmd.kill_on_drop(true);
    output(cmd.output().await)
}

/// For callers that can't await; only for rare, quick work.
fn git_blocking(cwd: &Path, args: &[&str]) -> Result<Output, GitError> {
    output(command(cwd, args).output())
}

/// The checkout `cwd` is in; `None` when it isn't in one (or doesn't exist).
pub async fn repo(cwd: &Path) -> Result<Option<GitRepo>, GitError> {
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
    let root = top.stdout.trim().to_owned();
    // Exit 1: detached.
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
            "--format=%(refname)%00%(upstream:short)%00%(upstream:track,nobracket)%00%(committerdate:unix)%00%(worktreepath)%00%(subject)",
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
    // Without optional locks, so it never holds the index while an agent
    // runs git here.
    let changes = git(cwd, &["--no-optional-locks", "status", "--porcelain"])
        .await?
        .checked()
        .map_or(0, |out| out.lines().count() as u32);

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
            let worktree = fields
                .next()
                .filter(|p| !p.is_empty() && !same_path(p, &root))
                .map(str::to_owned);
            let subject = fields.next().filter(|s| !s.is_empty()).map(str::to_owned);
            Some(GitBranch {
                worktree,
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
        root,
        branch,
        commit,
        changes,
        branches,
    }))
}

/// Git prints paths with forward slashes; Windows drives come in either case.
fn same_path(a: &str, b: &str) -> bool {
    let norm = |p: &str| {
        let p = p.replace('\\', "/");
        let p = p.trim_end_matches('/');
        if cfg!(windows) {
            p.to_lowercase()
        } else {
            p.to_owned()
        }
    };
    norm(a) == norm(b)
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

// Worktrees

/// A branch name from free text: its first few words, lowercased, as
/// `fix-the-login-bug`; `"chat"` when nothing usable is left.
pub fn branch_slug(hint: &str) -> String {
    let mut slug = String::new();
    let words = hint
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|w| !w.is_empty())
        .take(5);
    for word in words {
        let word = word.to_ascii_lowercase();
        let word = &word[..word.len().min(24)];
        if !slug.is_empty() && slug.len() + 1 + word.len() > 40 {
            break;
        }
        if !slug.is_empty() {
            slug.push('-');
        }
        slug.push_str(word);
    }
    if slug.is_empty() {
        "chat".into()
    } else {
        slug
    }
}

async fn branch_exists(cwd: &Path, name: &str) -> Result<bool, GitError> {
    let refname = format!("refs/heads/{name}");
    Ok(git(cwd, &["show-ref", "--verify", "--quiet", &refname])
        .await?
        .ok())
}

/// Git's `a/b/` prefix, under `root`.
fn join_prefix(root: &Path, prefix: &str) -> PathBuf {
    prefix
        .split('/')
        .filter(|part| !part.is_empty())
        .fold(root.to_path_buf(), |path, part| path.join(part))
}

fn io_error(e: std::io::Error) -> GitError {
    GitError::Failed(e.to_string())
}

/// Makes a worktree for a chat in `cwd`'s repository: a new branch
/// `hive/<slug of hint>` (numbered when taken) off `base` (when missing,
/// the checked-out branch, else HEAD's commit), checked out at
/// `dir/<repository name>` so the folder keeps the project's name. The
/// agent runs in the same subfolder of it that `cwd` is of its repository.
pub async fn add_worktree(
    cwd: &Path,
    dir: &Path,
    base: Option<&str>,
    hint: &str,
) -> Result<Worktree, GitError> {
    let out = git(cwd, &["rev-parse", "--show-toplevel", "--show-prefix"])
        .await?
        .checked()?;
    let mut lines = out.lines();
    let top = PathBuf::from(lines.next().unwrap_or_default().trim());
    let prefix = lines.next().unwrap_or_default().trim().to_owned();

    let base = match base.map(str::trim).filter(|b| !b.is_empty()) {
        Some(base) => existing(base)?.to_owned(),
        None => {
            let head = git(&top, &["symbolic-ref", "-q", "--short", "HEAD"]).await?;
            if head.ok() {
                head.stdout.trim().to_owned()
            } else {
                git(&top, &["rev-parse", "--short", "HEAD"])
                    .await?
                    .checked()?
                    .trim()
                    .to_owned()
            }
        }
    };
    let commit = format!("{base}^{{commit}}");
    if !git(&top, &["rev-parse", "--verify", "--quiet", &commit])
        .await?
        .ok()
    {
        return Err(GitError::Failed(format!(
            "“{base}” has no commit to start a worktree from."
        )));
    }

    let slug = format!("hive/{}", branch_slug(hint));
    let mut branch = slug.clone();
    let mut n = 1;
    while branch_exists(&top, &branch).await? {
        n += 1;
        branch = format!("{slug}-{n}");
    }
    check_name(&top, &branch).await?;

    let name = top
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| "repo".into());
    let root = dir.join(name);
    if root.exists() {
        return Err(GitError::Failed(format!("{} already exists.", root.display())));
    }
    std::fs::create_dir_all(dir).map_err(io_error)?;
    let root_arg = root.to_string_lossy().into_owned();
    let added = git(
        &top,
        &["worktree", "add", "--no-track", "-b", &branch, &root_arg, &base],
    )
    .await?;
    if !added.ok() {
        // Only removed while empty, which is how it was made.
        let _ = std::fs::remove_dir(dir);
        return Err(added.error());
    }
    let path = join_prefix(&root, &prefix);
    // A subfolder that's only in the project's checkout (untracked) still
    // has to exist to run in.
    std::fs::create_dir_all(&path).map_err(io_error)?;
    Ok(Worktree {
        root: root_arg,
        path: path.to_string_lossy().into_owned(),
        branch,
        base,
    })
}

/// Puts a chat's worktree back when its folder has gone missing (deleted by
/// hand, or by a cleaner): re-adds it from its branch, or remakes the branch
/// off `base` when that's gone too. True when it had to. Blocking, for the
/// engine's turn start; the folder being there costs no git call.
pub fn restore_worktree(cwd: &Path, worktree: &Worktree) -> Result<bool, GitError> {
    let root = Path::new(&worktree.root);
    let path = Path::new(&worktree.path);
    if root.join(".git").exists() {
        if path.is_dir() {
            return Ok(false);
        }
        std::fs::create_dir_all(path).map_err(io_error)?;
        return Ok(true);
    }
    if !cwd.is_dir() {
        return Err(GitError::Failed(format!("{} no longer exists.", cwd.display())));
    }
    if root.read_dir().is_ok_and(|mut d| d.next().is_some()) {
        return Err(GitError::Failed(format!(
            "{} isn't a worktree any more; move it away and try again.",
            root.display()
        )));
    }
    // Forgets the missing worktree, which still holds its branch.
    git_blocking(cwd, &["worktree", "prune"])?.checked()?;
    let branch = existing(&worktree.branch)?;
    let refname = format!("refs/heads/{branch}");
    let has_branch = git_blocking(cwd, &["show-ref", "--verify", "--quiet", &refname])?.ok();
    let root_arg = worktree.root.as_str();
    let added = if has_branch {
        git_blocking(cwd, &["worktree", "add", root_arg, branch])?
    } else {
        let base = existing(&worktree.base)?;
        git_blocking(
            cwd,
            &["worktree", "add", "--no-track", "-b", branch, root_arg, base],
        )?
    };
    added.checked()?;
    std::fs::create_dir_all(path).map_err(io_error)?;
    Ok(true)
}

/// Removes a chat's worktree folder, uncommitted changes and all, and git's
/// record of it; the branch stays. Retries for a few seconds, since files
/// the agent's process just let go of can stay locked a moment (Windows).
/// Its parent folder goes too once empty.
pub async fn remove_worktree(cwd: &Path, worktree: &Worktree) -> Result<(), GitError> {
    let root = Path::new(&worktree.root);
    let mut failure = None;
    for attempt in 0..6u64 {
        if !root.exists() {
            failure = None;
            break;
        }
        if attempt > 0 {
            tokio::time::sleep(Duration::from_millis(500 * attempt)).await;
        }
        let by_git = cwd.is_dir()
            && git(cwd, &["worktree", "remove", "--force", &worktree.root])
                .await
                .is_ok_and(|out| out.ok());
        if by_git {
            failure = None;
            break;
        }
        // Git couldn't (the project is gone, or it doesn't know this
        // worktree): delete the folder itself.
        match std::fs::remove_dir_all(root) {
            Ok(()) => {
                failure = None;
                break;
            }
            Err(e) => failure = Some(e),
        }
    }
    if cwd.is_dir() {
        let _ = git(cwd, &["worktree", "prune"]).await;
    }
    if let Some(parent) = root.parent() {
        // Only while empty.
        let _ = std::fs::remove_dir(parent);
    }
    match failure {
        Some(e) => Err(GitError::Failed(format!(
            "Couldn't remove {}: {e}",
            root.display()
        ))),
        None => Ok(()),
    }
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
    async fn diffs_the_working_tree_and_a_branch() {
        let Some(dir) = fixture().await else { return };
        let path = dir.path();

        let clean = diff(path, None).await.unwrap().unwrap();
        assert_eq!(clean.branch.as_deref(), Some("main"));
        assert!(clean.patch.is_empty() && !clean.truncated);

        std::fs::write(path.join("a.txt"), "b\n").unwrap();
        std::fs::create_dir(path.join("new dir")).unwrap();
        std::fs::write(path.join("new dir/n.txt"), "x\ny\n").unwrap();
        let d = diff(path, None).await.unwrap().unwrap();
        assert!(d.patch.contains("diff --git a/a.txt b/a.txt"), "{}", d.patch);
        assert!(d.patch.contains("-a\n"));
        assert!(d.patch.contains("+b\n"));
        assert!(d.patch.contains("diff --git a/new dir/n.txt b/new dir/n.txt\nnew file mode"));
        assert!(d.patch.contains("+x\n+y\n"));

        // On a branch with a commit: against main, both the commit and the
        // working tree; against HEAD only the working tree.
        create(path, "feat/x", "main").await.unwrap();
        git(path, &["add", "a.txt"]).await.unwrap();
        git(path, &["commit", "-q", "-m", "change a"]).await.unwrap();
        let d = diff(path, None).await.unwrap().unwrap();
        assert!(!d.patch.contains("a/a.txt"));
        let d = diff(path, Some("main")).await.unwrap().unwrap();
        assert!(d.merge_base.is_some());
        assert!(d.patch.contains("diff --git a/a.txt b/a.txt"));
        assert!(d.patch.contains("new dir/n.txt"));
        assert!(diff(path, Some("nope")).await.is_err());
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

    #[tokio::test]
    async fn worktrees_are_added_restored_and_removed() {
        let Some(repo_dir) = fixture().await else { return };
        let path = repo_dir.path();
        std::fs::create_dir_all(path.join("pkg/app")).unwrap();
        let store = tempfile::tempdir().unwrap();
        let dir = store.path().join("abc");

        // From a subfolder: the agent runs in the same one of the worktree.
        let wt = add_worktree(&path.join("pkg/app"), &dir, None, "Fix the login bug, please!")
            .await
            .unwrap();
        assert_eq!(wt.branch, "hive/fix-the-login-bug-please");
        assert_eq!(wt.base, "main");
        assert!(Path::new(&wt.root).join(".git").exists());
        assert!(wt.path.replace('\\', "/").ends_with("/pkg/app"));
        assert!(Path::new(&wt.path).is_dir());

        // The branch is in use there, as the project's listing says.
        let r = repo(path).await.unwrap().unwrap();
        let branch = r.branches.iter().find(|b| b.name == wt.branch).unwrap();
        assert!(branch.worktree.is_some() && !branch.current);
        assert!(r.branches.iter().find(|b| b.name == "main").unwrap().worktree.is_none());
        // And the worktree's own listing sees it as checked out.
        let inside = repo(Path::new(&wt.root)).await.unwrap().unwrap();
        assert_eq!(inside.branch.as_deref(), Some(wt.branch.as_str()));
        assert!(inside.branches.iter().find(|b| b.name == "main").unwrap().worktree.is_some());

        // The same hint again gets a numbered branch.
        let dir2 = store.path().join("def");
        let wt2 = add_worktree(path, &dir2, Some("main"), "Fix the login bug, please!")
            .await
            .unwrap();
        assert_eq!(wt2.branch, "hive/fix-the-login-bug-please-2");

        // Uncommitted work, then the folder disappears.
        std::fs::write(Path::new(&wt.root).join("wip.txt"), "wip").unwrap();
        assert_eq!(repo(Path::new(&wt.root)).await.unwrap().unwrap().changes, 1);
        assert!(!restore_worktree(path, &wt).unwrap());
        std::fs::remove_dir_all(&wt.root).unwrap();
        assert!(restore_worktree(path, &wt).unwrap());
        assert!(Path::new(&wt.path).is_dir());

        remove_worktree(path, &wt).await.unwrap();
        assert!(!dir.exists());
        // The branch is kept.
        assert!(branch_exists(path, &wt.branch).await.unwrap());
        // With its branch gone too, a restore remakes it off the base.
        delete(path, &wt.branch).await.unwrap();
        assert!(restore_worktree(path, &wt).unwrap());
        remove_worktree(path, &wt).await.unwrap();
        remove_worktree(path, &wt2).await.unwrap();
        assert!(!dir2.exists());
    }

    #[test]
    fn slugs() {
        assert_eq!(branch_slug("Add dark mode to settings page now"), "add-dark-mode-to-settings");
        assert_eq!(branch_slug("  ¿¡ "), "chat");
        assert_eq!(branch_slug("über café"), "ber-caf");
        assert!(branch_slug(&"x".repeat(100)).len() <= 40);
    }

    #[test]
    fn parses_tracking() {
        assert_eq!(parse_track(""), (0, 0));
        assert_eq!(parse_track("gone"), (0, 0));
        assert_eq!(parse_track("ahead 2"), (2, 0));
        assert_eq!(parse_track("ahead 2, behind 11"), (2, 11));
    }
}
