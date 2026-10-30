//! Working-tree snapshots for the diff tab's "Latest turn" scope (zeron's
//! `diff_sync/turn_snapshot.rs`): when a prompt starts a turn the engine
//! snapshots the chat's checkout, and the turn's changes are that snapshot
//! against a fresh one.
//!
//! A snapshot is `git add -A` into a throwaway index, then `git write-tree`.
//! Both trees carry untracked (unignored) files, so a file that was already
//! untracked when the turn started diffs as the edit it is, not as new.
//!
//! `git add` writes a blob for every file it hashes, so two rules keep this
//! cheap and out of the user's repository:
//!
//! - **Hive's objects stay in Hive's folder.** Each snapshot writes into its
//!   own object directory (`GIT_OBJECT_DIRECTORY`) under the folder the
//!   engine gives it, reading the checkout's objects as an alternate. The
//!   checkout's database is never written to, and the directory is deleted
//!   with the snapshot.
//! - **The work is bounded.** Untracked files past [`MAX_UNTRACKED_FILE_BYTES`]
//!   and untracked folders past the untracked budget are left out (they never
//!   show in the turn's diff; tracked files always do), and a snapshot gives up
//!   after [`SNAPSHOT_TIMEOUT`].

use std::collections::{HashMap, HashSet};
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use hive_proto::GitDiff;
use tokio::io::AsyncWriteExt as _;
use tokio::process::Command;

use super::diff::{capped_command, MAX_PATCH_BYTES};
use super::{command, git, output, GitError};

/// Largest untracked file a snapshot carries; leaves room for ordinary
/// binary assets (screenshots, fonts).
const MAX_UNTRACKED_FILE_BYTES: u64 = 8 * 1024 * 1024;
/// Budget for untracked content, applied to each untracked folder on its own
/// and then to everything left. Source trees fit with room to spare; build
/// output, dependencies and datasets don't.
const MAX_UNTRACKED_FILES: usize = 10_000;
const MAX_UNTRACKED_BYTES: u64 = 256 * 1024 * 1024;
/// Cap on one untracked listing from git.
const MAX_LISTING_BYTES: usize = 8 * 1024 * 1024;
/// Backstop for a whole snapshot (a hung mount or clean filter).
const SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(120);
/// Path bytes per git invocation: Windows caps a command line at 32,767
/// UTF-16 units.
const MAX_PATH_ARGUMENT_BYTES: usize = 16 * 1024;

#[cfg(windows)]
const ALTERNATES_SEPARATOR: char = ';';
#[cfg(not(windows))]
const ALTERNATES_SEPARATOR: char = ':';

/// A checkout's working tree written as a git tree, with the private object
/// store holding it. Clones share the store; the last one to go deletes it.
#[derive(Debug, Clone)]
pub struct TreeSnapshot {
    /// The checkout's top folder, as git prints it.
    root: String,
    tree: String,
    store: Arc<ObjectStore>,
    /// Untracked paths left out of `tree` (git's spelling, from the root). A
    /// snapshot layered on this one leaves them as they are here.
    skipped: Arc<Vec<Vec<u8>>>,
}

impl TreeSnapshot {
    /// The checkout's top folder.
    pub fn root(&self) -> &str {
        &self.root
    }

    /// The tree's hash, readable only through this snapshot's store.
    pub fn tree(&self) -> &str {
        &self.tree
    }

    /// Points a git command at this snapshot's objects.
    fn apply_to(&self, cmd: &mut std::process::Command) {
        self.store.apply_to(cmd);
    }
}

/// One snapshot's object directory.
#[derive(Debug)]
struct ObjectStore {
    dir: PathBuf,
    /// The run folder it's in, where snapshots layered on it go too.
    parent: PathBuf,
    /// `GIT_ALTERNATE_OBJECT_DIRECTORIES`: the checkout's objects, behind the
    /// base snapshot's when there is one.
    alternates: OsString,
    /// A layered snapshot reads through its base's store, so that has to
    /// outlive it.
    _base: Option<Arc<ObjectStore>>,
}

impl ObjectStore {
    async fn create(
        parent: &Path,
        root: &Path,
        base: Option<&Arc<ObjectStore>>,
    ) -> Result<Self, GitError> {
        let alternates = match base {
            Some(base) => {
                let mut value = alternates_value(&[&base.objects_dir()]);
                value.push(ALTERNATES_SEPARATOR.to_string());
                value.push(&base.alternates);
                value
            }
            None => {
                // `--git-path` resolves a linked worktree to the shared database.
                let listed = git(
                    root,
                    &["rev-parse", "--path-format=absolute", "--git-path", "objects"],
                )
                .await?
                .checked()?;
                let path = listed.trim_end_matches(['\r', '\n']);
                if path.is_empty() {
                    return Err(GitError::Failed("Git didn't say where its objects are.".into()));
                }
                let mut value = alternates_value(&[Path::new(path)]);
                // A checkout that already borrows objects this way keeps doing so.
                if let Some(inherited) = std::env::var_os("GIT_ALTERNATE_OBJECT_DIRECTORIES")
                    .filter(|v| !v.is_empty())
                {
                    value.push(ALTERNATES_SEPARATOR.to_string());
                    value.push(inherited);
                }
                value
            }
        };
        // Absolute: git resolves it against the checkout, not this process.
        let parent = std::path::absolute(parent).map_err(io_error)?;
        let dir = parent.join(uuid::Uuid::new_v4().to_string());
        tokio::fs::create_dir_all(dir.join("objects"))
            .await
            .map_err(io_error)?;
        Ok(Self {
            dir,
            parent,
            alternates,
            _base: base.cloned(),
        })
    }

    fn objects_dir(&self) -> PathBuf {
        self.dir.join("objects")
    }

    fn apply_to(&self, cmd: &mut std::process::Command) {
        cmd.env("GIT_OBJECT_DIRECTORY", self.objects_dir());
        cmd.env("GIT_ALTERNATE_OBJECT_DIRECTORIES", &self.alternates);
    }
}

impl Drop for ObjectStore {
    fn drop(&mut self) {
        let dir = std::mem::take(&mut self.dir);
        // It can hold thousands of loose objects: off the async workers.
        match tokio::runtime::Handle::try_current() {
            Ok(runtime) => {
                runtime.spawn_blocking(move || {
                    let _ = std::fs::remove_dir_all(dir);
                });
            }
            Err(_) => {
                let _ = std::fs::remove_dir_all(dir);
            }
        }
    }
}

fn io_error(e: std::io::Error) -> GitError {
    GitError::Failed(format!("Turn snapshot: {e}"))
}

/// Encodes folders for `GIT_ALTERNATE_OBJECT_DIRECTORIES`: git splits it on
/// the platform's path-list separator and reads an entry starting with `"`
/// as a C-quoted path, the only way to name one containing the separator.
fn alternates_value(dirs: &[&Path]) -> OsString {
    let mut value = OsString::new();
    for (i, dir) in dirs.iter().enumerate() {
        if i > 0 {
            value.push(ALTERNATES_SEPARATOR.to_string());
        }
        match dir.to_str() {
            Some(text) if text.contains(ALTERNATES_SEPARATOR) || text.starts_with('"') => {
                value.push("\"");
                value.push(text.replace('\\', "\\\\").replace('"', "\\\""));
                value.push("\"");
            }
            _ => value.push(dir.as_os_str()),
        }
    }
    value
}

/// This process's folder under the stores' folder: other runs' are left over
/// ([`sweep_turn_snapshots`]).
fn run_id() -> &'static str {
    static RUN_ID: OnceLock<String> = OnceLock::new();
    RUN_ID.get_or_init(|| {
        let micros = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_micros());
        format!("{}-{micros}", std::process::id())
    })
}

/// Deletes the snapshot stores earlier runs left in `dir` (snapshots live in
/// memory, so nothing there is reachable after a restart). Blocking.
pub fn sweep_turn_snapshots(dir: &Path) {
    remove_other_runs(dir, OsStr::new(run_id()));
}

fn remove_other_runs(parent: &Path, current: &OsStr) {
    let Ok(entries) = std::fs::read_dir(parent) else {
        return;
    };
    for entry in entries.flatten() {
        if entry.file_name() == current {
            continue;
        }
        let path = entry.path();
        if std::fs::remove_dir_all(&path).is_err() {
            let _ = std::fs::remove_file(&path);
        }
    }
}

/// Snapshots the checkout `cwd` is in, its objects in a new store under
/// `dir`; `None` outside a checkout. Neither the real index nor the
/// checkout's object database is touched.
pub async fn snapshot_tree(cwd: &Path, dir: &Path) -> Result<Option<TreeSnapshot>, GitError> {
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
    snapshot_onto(&dir.join(run_id()), root, None).await.map(Some)
}

/// The turn's changes: `turn` against the checkout as it is now (a snapshot
/// layered on it, so only what changed since is written, and deleted again
/// before this returns).
pub async fn turn_diff(turn: &TreeSnapshot) -> Result<GitDiff, GitError> {
    let root = Path::new(&turn.root);
    let current = snapshot_onto(&turn.store.parent, turn.root.clone(), Some(turn)).await?;
    let branch = git(root, &["symbolic-ref", "-q", "--short", "HEAD"]).await?;
    let branch = branch.ok().then(|| branch.stdout.trim().to_owned());

    let mut cmd = command(
        root,
        &[
            "-c",
            "core.quotePath=false",
            "diff",
            "--no-ext-diff",
            "--no-color",
            "--find-renames",
            "--unified=3",
            turn.tree(),
            current.tree(),
            "--",
        ],
    );
    current.apply_to(&mut cmd);
    let (bytes, truncated) = capped_command(cmd, MAX_PATCH_BYTES).await?;
    let mut patch = String::from_utf8_lossy(&bytes).into_owned();
    if truncated {
        // Never end on half a line.
        patch.truncate(patch.rfind('\n').map_or(0, |i| i + 1));
    }
    Ok(GitDiff {
        root: turn.root.clone(),
        branch,
        merge_base: None,
        patch,
        truncated,
    })
}

/// A snapshot in a new store under `parent`, layered on `base` when given.
async fn snapshot_onto(
    parent: &Path,
    root: String,
    base: Option<&TreeSnapshot>,
) -> Result<TreeSnapshot, GitError> {
    // Its git children are killed on drop, so timing out stops them too.
    let snapshot = Box::pin(write_snapshot(parent, root, base));
    match tokio::time::timeout(SNAPSHOT_TIMEOUT, snapshot).await {
        Ok(result) => result,
        Err(_) => Err(GitError::Failed(format!(
            "The turn snapshot took over {}s.",
            SNAPSHOT_TIMEOUT.as_secs()
        ))),
    }
}

async fn write_snapshot(
    parent: &Path,
    root_text: String,
    base: Option<&TreeSnapshot>,
) -> Result<TreeSnapshot, GitError> {
    let root = Path::new(&root_text);
    let store = Arc::new(ObjectStore::create(parent, root, base.map(|b| &b.store)).await?);
    let mut skipped = untracked_to_skip(root).await?;
    let index = store.dir.join("index");
    if let Some(base) = base {
        // Start from the base tree and leave out what either side left out,
        // so a folder that crossed the budget mid-turn keeps its old state
        // instead of showing as thousands of added or deleted files.
        snapshot_git(root, &store, &index, &["read-tree", base.tree()], None)
            .await?
            .checked()?;
        let known: HashSet<&[u8]> = skipped.iter().map(Vec::as_slice).collect();
        let inherited: Vec<Vec<u8>> = base
            .skipped
            .iter()
            .filter(|p| !known.contains(p.as_slice()))
            .cloned()
            .collect();
        skipped.extend(inherited);
    }
    // NUL-separated pathspecs on stdin: no argv limit, no quoting.
    let mut pathspecs = b".\0".to_vec();
    for path in &skipped {
        pathspecs.extend_from_slice(b":(top,exclude,literal)");
        pathspecs.extend_from_slice(path);
        pathspecs.push(0);
    }
    snapshot_git(
        root,
        &store,
        &index,
        &[
            "add",
            "-A",
            "--ignore-errors",
            "--pathspec-from-file=-",
            "--pathspec-file-nul",
        ],
        Some(pathspecs),
    )
    .await?
    .checked()?;
    let written = snapshot_git(root, &store, &index, &["write-tree"], None).await;
    // Only the tree is kept; the index can run to tens of megabytes.
    let _ = tokio::fs::remove_file(&index).await;
    let tree = written?.checked()?.trim().to_owned();
    Ok(TreeSnapshot {
        root: root_text,
        tree,
        store,
        skipped: Arc::new(skipped),
    })
}

async fn snapshot_git(
    root: &Path,
    store: &ObjectStore,
    index: &Path,
    args: &[&str],
    stdin: Option<Vec<u8>>,
) -> Result<super::Output, GitError> {
    let mut std_cmd = command(root, args);
    std_cmd.env("GIT_INDEX_FILE", index);
    store.apply_to(&mut std_cmd);
    if stdin.is_some() {
        std_cmd.stdin(Stdio::piped());
    }
    let mut cmd = Command::from(std_cmd);
    cmd.kill_on_drop(true);
    let spawned = cmd.spawn();
    let mut child = match spawned {
        Ok(child) => child,
        Err(e) => return output(Err(e)),
    };
    if let (Some(input), Some(mut pipe)) = (stdin, child.stdin.take()) {
        // A short pathspec list would drop exclusions: a failed write fails.
        pipe.write_all(&input).await.map_err(io_error)?;
        pipe.shutdown().await.map_err(io_error)?;
        drop(pipe);
    }
    output(child.wait_with_output().await)
}

/// Runs git for its raw stdout (paths may not be UTF-8): (stdout, cut short).
async fn listing(root: &Path, args: &[OsString]) -> Result<(Vec<u8>, bool), GitError> {
    capped_command(command(root, args), MAX_LISTING_BYTES).await
}

#[cfg(unix)]
fn path_argument(path: &[u8]) -> OsString {
    use std::os::unix::ffi::OsStringExt as _;
    OsString::from_vec(path.to_vec())
}

#[cfg(not(unix))]
fn path_argument(path: &[u8]) -> OsString {
    OsString::from(String::from_utf8_lossy(path).into_owned())
}

/// `paths` in consecutive batches of at most `budget` bytes (a NUL each); a
/// path over budget is a batch of its own.
fn path_batches(paths: &[Vec<u8>], budget: usize) -> Vec<&[Vec<u8>]> {
    let mut batches = Vec::new();
    let mut start = 0;
    let mut bytes = 0;
    for (i, path) in paths.iter().enumerate() {
        let cost = path.len() + 1;
        if i > start && bytes + cost > budget {
            batches.push(&paths[start..i]);
            start = i;
            bytes = 0;
        }
        bytes += cost;
    }
    if start < paths.len() {
        batches.push(&paths[start..]);
    }
    batches
}

/// The untracked paths `git add` has to leave out, as git spells them from
/// the root.
///
/// Git lists untracked content as units: a file, or a wholly untracked
/// folder. A folder over the budget goes whole (a build tree is useless in
/// part); inside the folders that fit, and among loose files, only files past
/// [`MAX_UNTRACKED_FILE_BYTES`] go. If the rest is still over budget, the
/// largest units go until it fits.
async fn untracked_to_skip(root: &Path) -> Result<Vec<Vec<u8>>, GitError> {
    let args: Vec<OsString> = ["ls-files", "--others", "--exclude-standard", "--directory", "-z"]
        .into_iter()
        .map(OsString::from)
        .collect();
    let (out, truncated) = listing(root, &args).await?;
    if truncated {
        return Err(GitError::Failed("Too many untracked paths to snapshot.".into()));
    }
    let units = split_nul(&out);
    if units.is_empty() {
        return Ok(Vec::new());
    }

    // Measure folders with a walk that stops at the budget before asking git
    // to list them: git lists a folder in full, which takes seconds on a
    // build tree. The walk runs on a blocking thread that outlives this
    // future if the snapshot times out; the flag stops it.
    let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let _stop_walk = StopOnDrop(stop.clone());
    let walk_root = root.to_path_buf();
    let (mut skipped, dirs, files) =
        tokio::task::spawn_blocking(move || triage_units(&walk_root, units, &stop))
            .await
            .map_err(|e| GitError::Failed(format!("Untracked walk: {e}")))?;

    // Files inside the folders that fit, in git's own spelling: only git
    // knows which are ignored, and the names go back to git as pathspecs.
    let mut measured: Vec<Unit> = files
        .into_iter()
        .map(|path| Unit {
            files: vec![path.clone()],
            path,
        })
        .collect();
    let dir_units: HashMap<Vec<u8>, usize> = dirs
        .iter()
        .enumerate()
        .map(|(i, dir)| (dir.clone(), measured.len() + i))
        .collect();
    measured.extend(dirs.iter().map(|dir| Unit {
        path: dir.clone(),
        files: Vec::new(),
    }));
    for batch in path_batches(&dirs, MAX_PATH_ARGUMENT_BYTES) {
        let mut args: Vec<OsString> = [
            "--literal-pathspecs",
            "ls-files",
            "--others",
            "--exclude-standard",
            "-z",
            "--",
        ]
        .into_iter()
        .map(OsString::from)
        .collect();
        args.extend(batch.iter().map(|dir| path_argument(dir)));
        let (out, truncated) = listing(root, &args).await?;
        if truncated {
            // Can't be measured: leave every folder out, keep the loose files.
            skipped.extend(dirs);
            return Ok(skipped);
        }
        for file in split_nul(&out) {
            // Untracked units never nest: the file belongs to the one listed
            // folder among its ancestors.
            let owner = file
                .iter()
                .enumerate()
                .filter(|(_, b)| **b == b'/')
                .find_map(|(end, _)| dir_units.get(&file[..=end]));
            if let Some(&owner) = owner {
                measured[owner].files.push(file);
            }
        }
    }

    let stat_root = root.to_path_buf();
    let (oversized, excess) = tokio::task::spawn_blocking(move || fit_units(&stat_root, measured))
        .await
        .map_err(|e| GitError::Failed(format!("Untracked stat: {e}")))?;
    skipped.extend(oversized);
    skipped.extend(excess);
    Ok(skipped)
}

struct StopOnDrop(Arc<std::sync::atomic::AtomicBool>);

impl Drop for StopOnDrop {
    fn drop(&mut self) {
        self.0.store(true, std::sync::atomic::Ordering::Relaxed);
    }
}

/// An untracked unit (a loose file, or a wholly untracked folder) and the
/// files in it, as git spells them.
struct Unit {
    path: Vec<u8>,
    files: Vec<Vec<u8>>,
}

fn split_nul(bytes: &[u8]) -> Vec<Vec<u8>> {
    bytes
        .split(|b| *b == 0)
        .filter(|p| !p.is_empty())
        .map(<[u8]>::to_vec)
        .collect()
}

/// Sorts untracked units into folders over budget (skipped whole), folders
/// that fit, and loose files. Git ends a folder with a slash.
#[allow(clippy::type_complexity)]
fn triage_units(
    root: &Path,
    units: Vec<Vec<u8>>,
    stop: &std::sync::atomic::AtomicBool,
) -> (Vec<Vec<u8>>, Vec<Vec<u8>>, Vec<Vec<u8>>) {
    let mut skipped = Vec::new();
    let mut dirs = Vec::new();
    let mut files = Vec::new();
    for unit in units {
        if stop.load(std::sync::atomic::Ordering::Relaxed) {
            break;
        }
        if !unit.ends_with(b"/") {
            files.push(unit);
        } else if dir_exceeds_budget(&root.join(path_argument(&unit))) {
            skipped.push(unit);
        } else {
            dirs.push(unit);
        }
    }
    (skipped, dirs, files)
}

/// True once `dir` holds more unignored content than the untracked budget.
/// Stops at the budget, so the cost is bounded. Files past the per-file cap
/// count as files but not bytes: they're left out one by one, and mustn't
/// condemn the folder around them.
fn dir_exceeds_budget(dir: &Path) -> bool {
    let mut files = 0usize;
    let mut bytes = 0u64;
    let walk = ignore::WalkBuilder::new(dir)
        .hidden(false)
        .ignore(false)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .filter_entry(|e| e.file_name() != ".git")
        .build();
    for entry in walk.flatten() {
        let Some(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_dir() {
            continue;
        }
        files += 1;
        if kind.is_file() {
            if let Ok(meta) = entry.metadata() {
                if meta.len() <= MAX_UNTRACKED_FILE_BYTES {
                    bytes += meta.len();
                }
            }
        }
        if files > MAX_UNTRACKED_FILES || bytes > MAX_UNTRACKED_BYTES {
            return true;
        }
    }
    false
}

/// Files past the per-file cap, then the units to leave out so the rest fits
/// the budget: largest first, so one big folder or a pile of assets costs
/// only itself and new source files keep showing. A path gone since git
/// listed it costs nothing; `git add --ignore-errors` copes.
fn fit_units(root: &Path, units: Vec<Unit>) -> (Vec<Vec<u8>>, Vec<Vec<u8>>) {
    let mut oversized = Vec::new();
    // (path, files, bytes) each unit would add.
    let mut costs = Vec::with_capacity(units.len());
    for unit in units {
        let (mut files, mut bytes) = (0usize, 0u64);
        for file in unit.files {
            let Ok(meta) = std::fs::symlink_metadata(root.join(path_argument(&file))) else {
                continue;
            };
            if meta.is_file() && meta.len() > MAX_UNTRACKED_FILE_BYTES {
                oversized.push(file);
                continue;
            }
            files += 1;
            if meta.is_file() {
                bytes += meta.len();
            }
        }
        costs.push((unit.path, files, bytes));
    }
    let mut files: usize = costs.iter().map(|c| c.1).sum();
    let mut bytes: u64 = costs.iter().map(|c| c.2).sum();
    let mut excess = Vec::new();
    if files <= MAX_UNTRACKED_FILES && bytes <= MAX_UNTRACKED_BYTES {
        return (oversized, excess);
    }
    // Largest first, measured against the budget it overruns most.
    let weight = |f: usize, b: u64| {
        (f as f64 / MAX_UNTRACKED_FILES as f64).max(b as f64 / MAX_UNTRACKED_BYTES as f64)
    };
    costs.sort_by(|a, b| weight(b.1, b.2).total_cmp(&weight(a.1, a.2)));
    for (path, unit_files, unit_bytes) in costs {
        if files <= MAX_UNTRACKED_FILES && bytes <= MAX_UNTRACKED_BYTES {
            break;
        }
        files -= unit_files;
        bytes -= unit_bytes;
        // A loose file's oversized self is already left out.
        if unit_files > 0 || unit_bytes > 0 {
            excess.push(path);
        }
    }
    (oversized, excess)
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use super::*;

    /// A repository with `a.txt` committed; `None` without git.
    async fn fixture() -> Option<tempfile::TempDir> {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        for args in [
            &["init", "-q", "-b", "main"][..],
            &["config", "user.email", "hive@example.com"],
            &["config", "user.name", "Hive"],
            &["config", "commit.gpgsign", "false"],
            &["config", "core.autocrlf", "false"],
        ] {
            git(&repo, args).await.ok().filter(|o| o.ok())?;
        }
        std::fs::write(repo.join("a.txt"), "one\ntwo\n").unwrap();
        git(&repo, &["add", "."]).await.ok().filter(|o| o.ok())?;
        git(&repo, &["commit", "-q", "-m", "first"]).await.ok().filter(|o| o.ok())?;
        Some(dir)
    }

    /// Every file in the checkout's object database.
    fn checkout_objects(repo: &Path) -> BTreeSet<PathBuf> {
        fn collect(dir: &Path, out: &mut BTreeSet<PathBuf>) {
            for entry in std::fs::read_dir(dir).unwrap().flatten() {
                let path = entry.path();
                if path.is_dir() {
                    collect(&path, out);
                } else {
                    out.insert(path);
                }
            }
        }
        let mut out = BTreeSet::new();
        collect(&repo.join(".git").join("objects"), &mut out);
        out
    }

    fn changed_paths(diff: &GitDiff) -> Vec<&str> {
        diff.patch
            .lines()
            .filter_map(|l| l.strip_prefix("diff --git a/"))
            .map(|l| l.split(" b/").next().unwrap())
            .collect()
    }

    fn sized_file(path: &Path, len: u64) {
        std::fs::File::create(path).and_then(|f| f.set_len(len)).unwrap();
    }

    #[tokio::test]
    async fn diffs_the_turn_without_writing_to_the_checkout() {
        let Some(tmp) = fixture().await else { return };
        let repo = tmp.path().join("repo");
        let stores = tmp.path().join("stores");
        // Changed before the turn: not the turn's.
        std::fs::write(repo.join("a.txt"), "one\ntwo\nbefore\n").unwrap();
        std::fs::write(repo.join("notes.txt"), "untracked before\n").unwrap();
        let before = checkout_objects(&repo);

        let turn = snapshot_tree(&repo, &stores).await.unwrap().unwrap();
        std::fs::write(repo.join("a.txt"), "one\ntwo\nbefore\nduring\n").unwrap();
        std::fs::write(repo.join("notes.txt"), "untracked before\nand during\n").unwrap();
        std::fs::write(repo.join("new.txt"), "new\n").unwrap();
        let diff = turn_diff(&turn).await.unwrap();

        assert_eq!(changed_paths(&diff), ["a.txt", "new.txt", "notes.txt"]);
        assert!(diff.patch.contains("+during"));
        assert!(!diff.patch.contains("+before"));
        // Untracked at the start: an edit, not a new file.
        assert!(diff.patch.contains("+and during"));
        assert!(!diff.patch.contains("+untracked before"));
        assert_eq!(diff.branch.as_deref(), Some("main"));
        assert_eq!(checkout_objects(&repo), before, "objects leaked into the checkout");

        // The stores go with the snapshots (the diff's own off-thread).
        let run = stores.join(run_id());
        assert!(run.join(turn.store.dir.file_name().unwrap()).is_dir());
        drop(turn);
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while std::fs::read_dir(&run).unwrap().count() > 0 {
            assert!(std::time::Instant::now() < deadline, "store not deleted");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    #[tokio::test]
    async fn an_unchanged_turn_is_empty() {
        let Some(tmp) = fixture().await else { return };
        let repo = tmp.path().join("repo");
        std::fs::write(repo.join("a.txt"), "dirty\n").unwrap();
        let turn = snapshot_tree(&repo, &tmp.path().join("stores")).await.unwrap().unwrap();
        let diff = turn_diff(&turn).await.unwrap();
        assert!(diff.patch.is_empty() && !diff.truncated, "{}", diff.patch);
    }

    #[tokio::test]
    async fn oversized_untracked_files_are_left_out() {
        let Some(tmp) = fixture().await else { return };
        let repo = tmp.path().join("repo");
        let turn = snapshot_tree(&repo, &tmp.path().join("stores")).await.unwrap().unwrap();
        std::fs::write(repo.join("small.txt"), "small\n").unwrap();
        sized_file(&repo.join("dump.bin"), MAX_UNTRACKED_FILE_BYTES + 1);
        let diff = turn_diff(&turn).await.unwrap();
        assert_eq!(changed_paths(&diff), ["small.txt"]);
    }

    #[tokio::test]
    async fn a_plain_folder_has_no_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        if git(dir.path(), &["rev-parse", "--git-dir"]).await.is_ok_and(|o| o.ok()) {
            return;
        }
        let stores = dir.path().join("stores");
        assert!(snapshot_tree(dir.path(), &stores).await.unwrap().is_none());
    }

    #[test]
    fn stale_runs_are_swept() {
        let tmp = tempfile::tempdir().unwrap();
        let stale = tmp.path().join("4242-1700000000000000").join("x");
        let current = tmp.path().join(run_id()).join("x");
        std::fs::create_dir_all(stale.join("objects")).unwrap();
        std::fs::create_dir_all(current.join("objects")).unwrap();
        sweep_turn_snapshots(tmp.path());
        assert!(!tmp.path().join("4242-1700000000000000").exists());
        assert!(current.join("objects").is_dir());
        sweep_turn_snapshots(&tmp.path().join("missing"));
    }

    #[test]
    fn path_batches_keep_every_path() {
        let paths: Vec<Vec<u8>> = ["aaa", "bbb", "cc", "dddddddddd", "e"]
            .iter()
            .map(|p| p.as_bytes().to_vec())
            .collect();
        let batches = path_batches(&paths, 8);
        let sizes: Vec<usize> = batches.iter().map(|b| b.len()).collect();
        assert_eq!(sizes, vec![2, 1, 1, 1]);
        assert_eq!(batches.concat(), paths);
    }
}
