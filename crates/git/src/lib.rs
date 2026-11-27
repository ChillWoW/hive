//! outcode-git — a project folder's branches and Outcode's worktrees, over
//! the `git` the user has installed: list branches, switch, branch off one,
//! delete one; add, restore and remove a chat's worktree; read its history.

mod history;

pub use history::{
    HISTORY_DEFAULT_LIMIT, HISTORY_MAX_LIMIT, commit_detail, fetch_all, github_remote, history,
    search_history,
};

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use outcode_proto::{GitBranch, GitChanges, GitFileState, GitRepo, Worktree};
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

impl From<std::process::Output> for Output {
    fn from(out: std::process::Output) -> Self {
        Self {
            code: out.status.code(),
            stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
        }
    }
}

fn command(cwd: &Path, args: &[&str]) -> std::process::Command {
    let mut cmd = std::process::Command::new("git");
    cmd.args(args)
        .current_dir(cwd)
        // Messages in English (they're matched on), and never a prompt.
        .env("LC_ALL", "C")
        .env("GIT_TERMINAL_PROMPT", "0")
        // Reads never rewrite the index under an agent running git here.
        .env("GIT_OPTIONAL_LOCKS", "0")
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

/// Git failing to start.
fn spawn_error(e: std::io::Error) -> GitError {
    match e.kind() {
        std::io::ErrorKind::NotFound => GitError::NotInstalled,
        _ => GitError::Failed(e.to_string()),
    }
}

async fn git(cwd: &Path, args: &[&str]) -> Result<Output, GitError> {
    let mut cmd = Command::from(command(cwd, args));
    cmd.kill_on_drop(true);
    cmd.output().await.map(Output::from).map_err(spawn_error)
}

/// For callers that can't await; only for rare, quick work.
fn git_blocking(cwd: &Path, args: &[&str]) -> Result<Output, GitError> {
    command(cwd, args).output().map(Output::from).map_err(spawn_error)
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
    let changes = git(cwd, &["status", "--porcelain"])
        .await?
        .checked()
        .map_or(0, |out| out.lines().count() as u32);

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
        changes,
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

// Changes

/// Git's empty tree, to diff against before the first commit.
const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/// At most this many untracked files are diffed, each at most this big.
const MAX_UNTRACKED: usize = 200;
const MAX_UNTRACKED_BYTES: u64 = 1024 * 1024;

/// Plain patch output whatever the user's config: no colour, external diff
/// tools or odd prefixes, paths unquoted.
const PATCH_ARGS: [&str; 6] = [
    "--no-color",
    "--no-ext-diff",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    "--find-renames",
    "--submodule=short",
];

/// The uncommitted changes in the checkout `cwd` is in (staged or not, and
/// untracked files as new ones), as one patch; `None` outside a checkout.
pub async fn changes(cwd: &Path) -> Result<Option<GitChanges>, GitError> {
    let Some(root) = toplevel(cwd).await? else {
        return Ok(None);
    };
    let top = Path::new(&root);
    let has_head = git(top, &["rev-parse", "--verify", "--quiet", "HEAD"]).await?.ok();
    let base = if has_head { "HEAD" } else { EMPTY_TREE };

    let mut args = vec!["-c", "core.quotePath=false", "diff"];
    args.extend(PATCH_ARGS);
    args.extend([base, "--"]);
    let mut patch = git(top, &args).await?.checked()?;

    let listed = git(top, &["ls-files", "--others", "--exclude-standard", "-z"])
        .await?
        .checked()?;
    let untracked: Vec<&str> = listed.split('\0').filter(|p| !p.is_empty()).collect();
    let mut skipped = untracked.len().saturating_sub(MAX_UNTRACKED) as u32;
    let mut diffs = tokio::task::JoinSet::new();
    for (at, path) in untracked.into_iter().take(MAX_UNTRACKED).enumerate() {
        let small = std::fs::metadata(top.join(path)).is_ok_and(|m| m.len() <= MAX_UNTRACKED_BYTES);
        if !small {
            skipped += 1;
            continue;
        }
        let (top, path) = (top.to_path_buf(), path.to_owned());
        diffs.spawn(async move {
            let mut args = vec!["-c", "core.quotePath=false", "diff", "--no-index"];
            args.extend(PATCH_ARGS);
            args.extend(["--", "/dev/null", &path]);
            // Exit 1: they differ, as they always do here.
            let out = git(&top, &args).await.ok().filter(|o| matches!(o.code, Some(0 | 1)));
            (at, out.map(|o| o.stdout))
        });
    }
    let mut added: Vec<(usize, String)> = Vec::new();
    while let Some(done) = diffs.join_next().await {
        match done {
            Ok((at, Some(text))) => added.push((at, text)),
            _ => skipped += 1,
        }
    }
    added.sort_by_key(|(at, _)| *at);
    for (_, text) in added {
        patch.push_str(&text);
    }
    Ok(Some(GitChanges { root, patch, skipped }))
}

/// The checkout `cwd` is in: its top folder and each uncommitted file
/// (untracked ones included), paths relative to that folder; `None` outside
/// a checkout.
pub async fn status(cwd: &Path) -> Result<Option<(String, Vec<(String, GitFileState)>)>, GitError> {
    let Some(root) = toplevel(cwd).await? else {
        return Ok(None);
    };
    let out = git(
        Path::new(&root),
        &["-c", "core.quotePath=false", "status", "--porcelain=v1", "-z", "--untracked-files=all"],
    )
    .await?
    .checked()?;
    Ok(Some((root, parse_status(&out))))
}

/// Each uncommitted file at or under `cwd` (untracked ones included), paths
/// relative to `cwd`; `None` outside a checkout.
pub async fn status_under(cwd: &Path) -> Result<Option<Vec<(String, GitFileState)>>, GitError> {
    if toplevel(cwd).await?.is_none() {
        return Ok(None);
    }
    // `cwd` from the checkout's top folder: `""`, or `src/app/`.
    let prefix = git(cwd, &["rev-parse", "--show-prefix"]).await?.checked()?;
    let prefix = prefix.trim();
    let out = git(
        cwd,
        &["-c", "core.quotePath=false", "status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."],
    )
    .await?
    .checked()?;
    let files = parse_status(&out)
        .into_iter()
        .filter_map(|(path, state)| Some((path.strip_prefix(prefix)?.to_owned(), state)))
        .collect();
    Ok(Some(files))
}

/// `git status --porcelain=v1 -z`: `XY path`, a rename's or copy's old path
/// after it as an entry of its own.
fn parse_status(out: &str) -> Vec<(String, GitFileState)> {
    let mut files = Vec::new();
    let mut entries = out.split('\0').filter(|e| !e.is_empty());
    while let Some(entry) = entries.next() {
        let (Some(code), Some(path)) = (entry.get(..2), entry.get(3..)) else {
            continue;
        };
        let (x, y) = (code.as_bytes()[0], code.as_bytes()[1]);
        let state = match (x, y) {
            (b'?', b'?') => GitFileState::Untracked,
            (b'U', _) | (_, b'U') | (b'A', b'A') | (b'D', b'D') => GitFileState::Conflict,
            (b'R' | b'C', _) | (_, b'R' | b'C') => {
                entries.next();
                GitFileState::Renamed
            }
            (b'A', _) => GitFileState::Added,
            (b'D', _) | (_, b'D') => GitFileState::Deleted,
            _ => GitFileState::Modified,
        };
        files.push((path.to_owned(), state));
    }
    files
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
    if slug.is_empty() { "chat".into() } else { slug }
}

/// `<prefix>/<slug>`, or just the slug for an empty prefix.
pub fn prefixed(prefix: &str, slug: &str) -> String {
    match prefix.trim().trim_matches('/') {
        "" => slug.to_owned(),
        prefix => format!("{prefix}/{slug}"),
    }
}

async fn branch_exists(cwd: &Path, name: &str) -> Result<bool, GitError> {
    let refname = format!("refs/heads/{name}");
    Ok(git(cwd, &["show-ref", "--verify", "--quiet", &refname]).await?.ok())
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
/// `<branch_prefix>/<slug of hint>` (just the slug for an empty prefix;
/// numbered when taken) off `base` (when missing, the checked-out branch,
/// else HEAD's commit), checked out at `dir/<repository name>` so the folder
/// keeps the project's name. The agent runs in the same subfolder of it that
/// `cwd` is of its repository.
pub async fn add_worktree(
    cwd: &Path,
    dir: &Path,
    base: Option<&str>,
    branch_prefix: &str,
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
        None => match current_branch(&top).await? {
            Some(branch) => branch,
            None => git(&top, &["rev-parse", "--short", "HEAD"])
                .await?
                .checked()?
                .trim()
                .to_owned(),
        },
    };
    let commit = format!("{base}^{{commit}}");
    if !git(&top, &["rev-parse", "--verify", "--quiet", &commit]).await?.ok() {
        return Err(GitError::Failed(format!(
            "“{base}” has no commit to start a worktree from."
        )));
    }

    let slug = prefixed(branch_prefix, &branch_slug(hint));
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
        failure = None;
        if !root.exists() {
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
            break;
        }
        // Git couldn't (the project is gone, or it doesn't know this
        // worktree): delete the folder itself.
        match std::fs::remove_dir_all(root) {
            Ok(()) => break,
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
        Some(e) => Err(GitError::Failed(format!("Couldn't remove {}: {e}", root.display()))),
        None => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_lines_are_parsed() {
        let out = " M src/a.rs\0?? new.txt\0R  b.rs\0old b.rs\0A  c.rs\0 D d.rs\0UU e.rs\0";
        assert_eq!(
            parse_status(out),
            [
                ("src/a.rs".into(), GitFileState::Modified),
                ("new.txt".into(), GitFileState::Untracked),
                ("b.rs".into(), GitFileState::Renamed),
                ("c.rs".into(), GitFileState::Added),
                ("d.rs".into(), GitFileState::Deleted),
                ("e.rs".into(), GitFileState::Conflict),
            ]
        );
    }

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

    #[tokio::test]
    async fn worktrees_are_added_restored_and_removed() {
        let Some(repo_dir) = fixture().await else { return };
        let path = repo_dir.path();
        std::fs::create_dir_all(path.join("pkg/app")).unwrap();
        let store = tempfile::tempdir().unwrap();
        let dir = store.path().join("abc");

        // From a subfolder: the agent runs in the same one of the worktree.
        let wt = add_worktree(&path.join("pkg/app"), &dir, None, "outcode", "Fix the login bug, please!")
            .await
            .unwrap();
        assert_eq!(wt.branch, "outcode/fix-the-login-bug-please");
        assert_eq!(wt.base, "main");
        assert!(Path::new(&wt.root).join(".git").exists());
        assert!(wt.path.replace('\\', "/").ends_with("/pkg/app"));
        assert!(Path::new(&wt.path).is_dir());

        // The branch is in use there, as the project's listing says.
        let r = repo(path).await.unwrap().unwrap();
        let branch = r.branches.iter().find(|b| b.name == wt.branch).unwrap();
        assert!(branch.worktree.is_some() && !branch.current);
        let inside = repo(Path::new(&wt.root)).await.unwrap().unwrap();
        assert_eq!(inside.branch.as_deref(), Some(wt.branch.as_str()));

        // The same hint again gets a numbered branch.
        let dir2 = store.path().join("def");
        let wt2 = add_worktree(path, &dir2, Some("main"), "outcode", "Fix the login bug, please!")
            .await
            .unwrap();
        assert_eq!(wt2.branch, "outcode/fix-the-login-bug-please-2");

        // Another prefix, or none.
        let wt3 = add_worktree(path, &store.path().join("ghi"), None, "me/", "Fix it").await.unwrap();
        assert_eq!(wt3.branch, "me/fix-it");
        let wt4 = add_worktree(path, &store.path().join("jkl"), None, "", "Fix it").await.unwrap();
        assert_eq!(wt4.branch, "fix-it");

        // The folder disappears, and comes back.
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
        for w in [&wt, &wt2, &wt3, &wt4] {
            remove_worktree(path, w).await.unwrap();
        }
        assert!(!dir2.exists());
    }

    #[tokio::test]
    async fn changes_cover_tracked_and_untracked_files() {
        let Some(dir) = fixture().await else { return };
        let path = dir.path();
        assert!(changes(path).await.unwrap().unwrap().patch.is_empty());

        std::fs::write(path.join("a.txt"), "one\n").unwrap();
        git(path, &["add", "a.txt"]).await.unwrap().checked().unwrap();
        git(path, &["commit", "-q", "-m", "a"]).await.unwrap().checked().unwrap();
        std::fs::write(path.join("a.txt"), "two\n").unwrap();
        std::fs::create_dir(path.join("sub")).unwrap();
        std::fs::write(path.join("sub/new file.txt"), "hello\n").unwrap();

        let c = changes(&path.join("sub")).await.unwrap().unwrap();
        assert!(c.patch.contains("diff --git a/a.txt b/a.txt"));
        assert!(c.patch.contains("-one\n+two\n"));
        assert!(c.patch.contains("+++ b/sub/new file.txt"));
        assert!(c.patch.contains("+hello\n"));
        assert_eq!(c.skipped, 0);

        let plain = tempfile::tempdir().unwrap();
        assert_eq!(changes(plain.path()).await.unwrap(), None);
    }

    #[tokio::test]
    async fn status_under_a_folder_is_relative_to_it() {
        let Some(dir) = fixture().await else { return };
        let path = dir.path();
        std::fs::write(path.join("top.txt"), "top\n").unwrap();
        std::fs::create_dir_all(path.join("sub/deep")).unwrap();
        std::fs::write(path.join("sub/deep/new.txt"), "hello\n").unwrap();

        let mut all = status_under(path).await.unwrap().unwrap();
        all.sort_by(|a, b| a.0.cmp(&b.0));
        assert_eq!(
            all,
            [
                ("sub/deep/new.txt".to_owned(), GitFileState::Untracked),
                ("top.txt".to_owned(), GitFileState::Untracked),
            ]
        );
        assert_eq!(
            status_under(&path.join("sub")).await.unwrap().unwrap(),
            [("deep/new.txt".to_owned(), GitFileState::Untracked)]
        );

        let plain = tempfile::tempdir().unwrap();
        assert_eq!(status_under(plain.path()).await.unwrap(), None);
    }

    #[test]
    fn slugs() {
        assert_eq!(branch_slug("Add dark mode to settings page now"), "add-dark-mode-to-settings");
        assert_eq!(branch_slug("  ¿¡ "), "chat");
        assert_eq!(branch_slug("über café"), "ber-caf");
        assert!(branch_slug(&"x".repeat(100)).len() <= 40);
        assert_eq!(prefixed("/a/", "b"), "a/b");
        assert_eq!(prefixed(" ", "b"), "b");
    }
}
