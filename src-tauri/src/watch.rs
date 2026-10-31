//! Folder watches: what changed under a folder, batched and sent over a
//! `Channel`, so the file panel, diff tab, branch chip and open editor tabs
//! follow the disk instead of waiting for the window's focus.
//!
//! One OS watcher for recursive watches and one for flat ones (a single
//! folder, for editor tabs), shared by every subscription and counted per
//! path. Each subscription also watches its checkout's git dirs, so a commit
//! or branch switch reaches it as `git`. Paths `.gitignore` / `.ignore` hide
//! are only flagged as `ignored`, so a build writing into `target/` doesn't
//! re-read the diff.

use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use ignore::gitignore::{Gitignore, GitignoreBuilder};
use ignore::Match;
use notify::event::ModifyKind;
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{State, Webview};

/// A batch goes out once nothing changed for this long…
const QUIET: Duration = Duration::from_millis(200);
/// …or this long after its first change, whatever keeps changing.
const MAX_WAIT: Duration = Duration::from_secs(1);
/// Past this many paths a batch only says `overflow`.
const MAX_PATHS: usize = 500;

/// What changed under a watched folder since the last batch.
#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[cfg_attr(test, derive(serde::Deserialize))]
#[serde(rename_all = "camelCase")]
pub struct FolderChange {
    /// Changed paths `.gitignore` doesn't hide (in a flat watch, every one),
    /// relative to the folder, `/`-separated.
    paths: Vec<String>,
    /// The folders ("" for the folder itself) where an entry appeared, went
    /// or was renamed, ignored ones included.
    dirs: Vec<String>,
    /// Too many folders for `dirs`: any listing may be stale.
    dirs_overflow: bool,
    /// An entry `.gitignore` doesn't hide appeared, went or was renamed.
    entries: bool,
    /// Something ignored changed too.
    ignored: bool,
    /// HEAD, a ref or the index moved.
    git: bool,
    /// Too much to list (or the OS dropped events): anything may have changed.
    overflow: bool,
}

struct Batch {
    paths: BTreeSet<String>,
    dirs: BTreeSet<String>,
    dirs_overflow: bool,
    entries: bool,
    ignored: bool,
    git: bool,
    overflow: bool,
    first: Instant,
    last: Instant,
}

impl Batch {
    fn new(now: Instant) -> Self {
        Batch {
            paths: BTreeSet::new(),
            dirs: BTreeSet::new(),
            dirs_overflow: false,
            entries: false,
            ignored: false,
            git: false,
            overflow: false,
            first: now,
            last: now,
        }
    }

    fn due(&self, now: Instant) -> bool {
        now >= self.last + QUIET || now >= self.first + MAX_WAIT
    }

    fn deadline(&self) -> Instant {
        (self.last + QUIET).min(self.first + MAX_WAIT)
    }
}

struct Sub {
    owner: String,
    root: PathBuf,
    recursive: bool,
    /// The checkout's git dirs (its own, then the common one), longest first.
    git_dirs: Vec<PathBuf>,
    /// Where ignore files stop applying: the checkout's top, else `root`.
    top: PathBuf,
    /// The common git dir's `info/exclude`, applied at `top`.
    exclude: Option<PathBuf>,
    /// What this subscription registered with the watchers.
    registered: Vec<(PathBuf, bool)>,
    /// Each folder's ignore files, read when first needed.
    ignores: HashMap<PathBuf, Option<Gitignore>>,
    channel: Channel<FolderChange>,
    batch: Option<Batch>,
}

impl Sub {
    fn batch(&mut self, now: Instant) -> &mut Batch {
        let batch = self.batch.get_or_insert_with(|| Batch::new(now));
        batch.last = now;
        batch
    }

    /// Whether `path` is this subscription's at all.
    fn covers(&self, path: &Path) -> bool {
        path.starts_with(&self.root) || self.git_dirs.iter().any(|g| path.starts_with(g))
    }

    /// Adds `path` to the batch; `structural` when an entry appeared, went
    /// or was renamed rather than just written.
    fn note(&mut self, path: &Path, structural: bool, now: Instant) {
        if let Some(git_dir) = self.git_dirs.iter().find(|g| path.starts_with(g)) {
            if git_relevant(path.strip_prefix(git_dir).unwrap_or(path)) {
                self.batch(now).git = true;
            }
            return;
        }
        let Ok(rel) = path.strip_prefix(&self.root) else { return };
        let depth = rel.components().count();
        if depth == 0 || (!self.recursive && depth != 1) {
            return;
        }
        // A worktree's `.git` file, a nested checkout's git dir.
        if rel.components().any(|c| c.as_os_str() == ".git") {
            return;
        }
        let name = path.file_name().unwrap_or_default();
        if name == ".gitignore" || name == ".ignore" {
            if let Some(parent) = path.parent() {
                self.ignores.remove(parent);
            }
        }
        // A flat watch is for open files, which may well be ignored ones.
        let ignored = self.recursive && self.is_ignored(path);
        let rel = rel.to_string_lossy().replace('\\', "/");
        let batch = self.batch(now);
        if structural {
            if !ignored {
                batch.entries = true;
            }
            if !batch.dirs_overflow {
                let dir = rel.rfind('/').map_or("", |i| &rel[..i]);
                batch.dirs.insert(dir.to_owned());
                if batch.dirs.len() > MAX_PATHS {
                    batch.dirs.clear();
                    batch.dirs_overflow = true;
                }
            }
        }
        if ignored {
            batch.ignored = true;
        } else if !batch.overflow {
            batch.paths.insert(rel);
            if batch.paths.len() > MAX_PATHS {
                batch.paths.clear();
                batch.overflow = true;
            }
        }
    }

    /// `path` is hidden by an ignore file between it and `top`, the deepest
    /// one that says anything deciding.
    fn is_ignored(&mut self, path: &Path) -> bool {
        let is_dir = path.is_dir();
        let Some(parent) = path.parent() else { return false };
        for dir in parent.ancestors() {
            if !dir.starts_with(&self.top) {
                break;
            }
            if !self.ignores.contains_key(dir) {
                let exclude = if dir == self.top { self.exclude.as_deref() } else { None };
                self.ignores.insert(dir.to_path_buf(), read_ignores(dir, exclude));
            }
            if let Some(gitignore) = &self.ignores[dir] {
                match gitignore.matched_path_or_any_parents(path, is_dir) {
                    Match::Ignore(_) => return true,
                    Match::Whitelist(_) => return false,
                    Match::None => {}
                }
            }
            if dir == self.top {
                break;
            }
        }
        false
    }

    fn flush(&mut self) {
        let Some(batch) = self.batch.take() else { return };
        let _ = self.channel.send(FolderChange {
            paths: batch.paths.into_iter().collect(),
            dirs: batch.dirs.into_iter().collect(),
            dirs_overflow: batch.dirs_overflow,
            entries: batch.entries,
            ignored: batch.ignored,
            git: batch.git,
            overflow: batch.overflow,
        });
    }
}

/// `dir`'s `.gitignore` and `.ignore` (the latter winning), plus `exclude`.
fn read_ignores(dir: &Path, exclude: Option<&Path>) -> Option<Gitignore> {
    let mut builder = GitignoreBuilder::new(dir);
    let mut any = false;
    for file in exclude
        .map(Path::to_path_buf)
        .into_iter()
        .chain([dir.join(".gitignore"), dir.join(".ignore")])
    {
        if file.is_file() {
            any = true;
            let _ = builder.add(file);
        }
    }
    if !any {
        return None;
    }
    builder.build().ok().filter(|g| g.num_ignores() + g.num_whitelists() > 0)
}

/// A git dir entry whose change means HEAD, a branch or the index moved.
/// Lock files, objects and logs don't: the rename that ends a write does.
fn git_relevant(rel: &Path) -> bool {
    let name = rel.file_name().unwrap_or_default().to_string_lossy();
    if name.ends_with(".lock") {
        return false;
    }
    let first = rel.components().next().map(|c| c.as_os_str().to_string_lossy().into_owned());
    matches!(
        first.as_deref(),
        Some("HEAD" | "index" | "packed-refs" | "refs" | "ORIG_HEAD" | "MERGE_HEAD" | "FETCH_HEAD")
    )
}

/// The checkout `dir` is in: (its top, its git dir, the common git dir).
fn checkout_of(dir: &Path) -> Option<(PathBuf, PathBuf, PathBuf)> {
    for top in dir.ancestors() {
        let dot_git = top.join(".git");
        if dot_git.is_dir() {
            return Some((top.to_path_buf(), dot_git.clone(), dot_git));
        }
        if dot_git.is_file() {
            // A worktree: `gitdir: <path>`, and that dir's `commondir`.
            let text = std::fs::read_to_string(&dot_git).ok()?;
            let git_dir = top.join(text.strip_prefix("gitdir:")?.trim());
            let common = std::fs::read_to_string(git_dir.join("commondir"))
                .map(|c| git_dir.join(c.trim()))
                .unwrap_or_else(|_| git_dir.clone());
            let clean = |p: PathBuf| std::fs::canonicalize(&p).map(strip_verbatim).unwrap_or(p);
            return Some((top.to_path_buf(), clean(git_dir), clean(common)));
        }
    }
    None
}

/// `\\?\C:\…` → `C:\…`, so it compares with the paths the webview sends.
fn strip_verbatim(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy();
    match text.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with("UNC\\") => PathBuf::from(rest),
        _ => path,
    }
}

type Events = mpsc::Sender<notify::Result<Event>>;

#[derive(Default)]
struct Inner {
    recursive: Option<RecommendedWatcher>,
    flat: Option<RecommendedWatcher>,
    counts: HashMap<(PathBuf, bool), usize>,
    subs: HashMap<u32, Sub>,
    next: u32,
}

impl Inner {
    fn register(&mut self, events: &Events, path: &Path, recursive: bool) -> notify::Result<()> {
        let key = (path.to_path_buf(), recursive);
        if let Some(count) = self.counts.get_mut(&key) {
            *count += 1;
            return Ok(());
        }
        let slot = if recursive { &mut self.recursive } else { &mut self.flat };
        if slot.is_none() {
            let events = events.clone();
            *slot = Some(notify::recommended_watcher(move |event| {
                let _ = events.send(event);
            })?);
        }
        let mode = if recursive { RecursiveMode::Recursive } else { RecursiveMode::NonRecursive };
        slot.as_mut().unwrap().watch(path, mode)?;
        self.counts.insert(key, 1);
        Ok(())
    }

    fn unregister(&mut self, path: &Path, recursive: bool) {
        let key = (path.to_path_buf(), recursive);
        let Some(count) = self.counts.get_mut(&key) else { return };
        *count -= 1;
        if *count > 0 {
            return;
        }
        self.counts.remove(&key);
        let slot = if recursive { &mut self.recursive } else { &mut self.flat };
        if let Some(watcher) = slot {
            let _ = watcher.unwatch(path);
        }
    }

    fn remove(&mut self, id: u32) {
        if let Some(sub) = self.subs.remove(&id) {
            for (path, recursive) in sub.registered {
                self.unregister(&path, recursive);
            }
        }
    }

    fn route(&mut self, event: notify::Result<Event>, now: Instant) {
        let (paths, rescan, structural) = match event {
            Ok(event) => {
                let structural = match event.kind {
                    EventKind::Access(_) => return,
                    EventKind::Create(_) | EventKind::Remove(_) | EventKind::Any => true,
                    EventKind::Modify(ModifyKind::Name(_) | ModifyKind::Any) => true,
                    _ => false,
                };
                let rescan = event.need_rescan();
                (event.paths, rescan, structural)
            }
            Err(error) => {
                log::warn!("folder watch: {error}");
                (error.paths, true, true)
            }
        };
        for sub in self.subs.values_mut() {
            if rescan && (paths.is_empty() || paths.iter().any(|p| sub.covers(p))) {
                let batch = sub.batch(now);
                batch.overflow = true;
                batch.paths.clear();
                batch.dirs.clear();
                batch.dirs_overflow = true;
                batch.entries = true;
                batch.git = true;
            }
            for path in &paths {
                sub.note(path, structural, now);
            }
        }
    }

    /// Sends the batches that are due; when the next one will be.
    fn flush(&mut self, now: Instant) -> Option<Instant> {
        let mut next: Option<Instant> = None;
        for sub in self.subs.values_mut() {
            let Some(batch) = &sub.batch else { continue };
            if batch.due(now) {
                sub.flush();
            } else {
                let at = batch.deadline();
                next = Some(next.map_or(at, |n| n.min(at)));
            }
        }
        next
    }
}

#[derive(Default)]
struct Shared {
    inner: Mutex<Inner>,
    events: OnceLock<Events>,
}

/// Every folder watch, by id.
#[derive(Default, Clone)]
pub struct FolderWatches(Arc<Shared>);

impl FolderWatches {
    /// Where the watchers send; the first call starts the thread batching them.
    fn events(&self) -> Events {
        self.0
            .events
            .get_or_init(|| {
                let (tx, rx) = mpsc::channel::<notify::Result<Event>>();
                let shared = Arc::downgrade(&self.0);
                std::thread::Builder::new()
                    .name("folder-watch".into())
                    .spawn(move || dispatch(shared, rx))
                    .expect("starting the folder watch thread");
                tx
            })
            .clone()
    }

    fn watch(
        &self,
        owner: String,
        root: PathBuf,
        recursive: bool,
        channel: Channel<FolderChange>,
    ) -> Result<u32, String> {
        if !root.is_dir() {
            return Err(format!("{} is not a folder", root.display()));
        }
        let events = self.events();
        let checkout = checkout_of(&root);
        let (top, git_dirs, exclude) = match &checkout {
            Some((top, git_dir, common)) => {
                let mut dirs = vec![git_dir.clone()];
                if common != git_dir {
                    dirs.push(common.clone());
                }
                dirs.sort_by_key(|d| std::cmp::Reverse(d.as_os_str().len()));
                // Ignore files above the folder count, inside its checkout.
                (top.clone(), dirs, Some(common.join("info").join("exclude")))
            }
            None => (root.clone(), Vec::new(), None),
        };

        let mut inner = self.0.inner.lock().unwrap();
        let mut registered: Vec<(PathBuf, bool)> = Vec::new();
        let mut wanted = vec![(root.clone(), recursive)];
        for dir in &git_dirs {
            // Already inside the folder's own recursive watch.
            if !(recursive && dir.starts_with(&root)) && dir.is_dir() {
                wanted.push((dir.clone(), true));
            }
        }
        for (path, rec) in wanted {
            if let Err(e) = inner.register(&events, &path, rec) {
                for (path, rec) in registered {
                    inner.unregister(&path, rec);
                }
                return Err(format!("watching {}: {e}", path.display()));
            }
            registered.push((path, rec));
        }

        let id = inner.next;
        inner.next += 1;
        inner.subs.insert(
            id,
            Sub {
                owner,
                root,
                recursive,
                git_dirs,
                top,
                exclude,
                registered,
                ignores: HashMap::new(),
                channel,
                batch: None,
            },
        );
        Ok(id)
    }

    fn unwatch(&self, id: u32) {
        self.0.inner.lock().unwrap().remove(id);
    }

    /// Drops the watches a webview made, as its page reloads.
    pub fn clear(&self, label: &str) {
        let mut inner = self.0.inner.lock().unwrap();
        let ids: Vec<u32> =
            inner.subs.iter().filter(|(_, s)| s.owner == label).map(|(id, _)| *id).collect();
        for id in ids {
            inner.remove(id);
        }
    }
}

fn dispatch(shared: std::sync::Weak<Shared>, rx: mpsc::Receiver<notify::Result<Event>>) {
    let mut next: Option<Instant> = None;
    loop {
        let wait = next
            .map(|at| at.saturating_duration_since(Instant::now()))
            .unwrap_or(Duration::from_secs(3600));
        let received = rx.recv_timeout(wait);
        let Some(shared) = shared.upgrade() else { return };
        let mut inner = shared.inner.lock().unwrap();
        match received {
            Ok(event) => {
                inner.route(event, Instant::now());
                // Take whatever else is already queued before sending.
                while let Ok(event) = rx.try_recv() {
                    inner.route(event, Instant::now());
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => return,
        }
        next = inner.flush(Instant::now());
    }
}

/// Watches `cwd` (everything under it, or with `recursive` false only what's
/// directly in it) and its checkout's git dirs; batches go to `on_change`.
/// The watch id, for `unwatch_folder`.
#[tauri::command]
pub async fn watch_folder(
    webview: Webview,
    watches: State<'_, FolderWatches>,
    cwd: String,
    recursive: bool,
    on_change: Channel<FolderChange>,
) -> Result<u32, String> {
    let watches = watches.inner().clone();
    let owner = webview.label().to_owned();
    // Registering a big tree can take a while (inotify walks it).
    tauri::async_runtime::spawn_blocking(move || {
        watches.watch(owner, PathBuf::from(cwd), recursive, on_change)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn unwatch_folder(watches: State<'_, FolderWatches>, id: u32) {
    watches.unwatch(id);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sub(root: &Path, recursive: bool) -> (Sub, Arc<Mutex<Vec<FolderChange>>>) {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = seen.clone();
        let channel = Channel::new(move |body| {
            if let tauri::ipc::InvokeResponseBody::Json(json) = body {
                sink.lock().unwrap().push(serde_json::from_str(&json).unwrap());
            }
            Ok(())
        });
        let (top, git_dir, common) = checkout_of(root).unwrap();
        let sub = Sub {
            owner: "main".into(),
            root: root.to_path_buf(),
            recursive,
            git_dirs: vec![git_dir],
            top,
            exclude: Some(common.join("info/exclude")),
            registered: Vec::new(),
            ignores: HashMap::new(),
            channel,
            batch: None,
        };
        (sub, seen)
    }

    fn repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join(".git/refs/heads")).unwrap();
        std::fs::create_dir_all(root.join("src/gen")).unwrap();
        std::fs::create_dir_all(root.join("target/debug")).unwrap();
        std::fs::write(root.join(".gitignore"), "target/\n*.log\n").unwrap();
        std::fs::write(root.join("src/.gitignore"), "gen/\n!keep.log\n").unwrap();
        dir
    }

    #[test]
    fn sorts_changes_into_paths_ignored_and_git() {
        let dir = repo();
        let root = dir.path();
        let (mut sub, seen) = sub(root, true);
        let now = Instant::now();
        for (path, structural) in [
            ("src/main.rs", false),
            ("target/debug/app.exe", true),
            ("debug.log", false),
            ("src/keep.log", true),
            ("src/gen/out.rs", false),
            (".git/index.lock", true),
            (".git/objects/ab/cdef", true),
        ] {
            sub.note(&root.join(path), structural, now);
        }
        assert!(!sub.batch.as_ref().unwrap().git);
        sub.note(&root.join(".git/refs/heads/main"), false, now);
        sub.flush();
        assert_eq!(
            *seen.lock().unwrap(),
            [FolderChange {
                paths: vec!["src/keep.log".into(), "src/main.rs".into()],
                dirs: vec!["src".into(), "target/debug".into()],
                dirs_overflow: false,
                entries: true,
                ignored: true,
                git: true,
                overflow: false,
            }]
        );
    }

    #[test]
    fn ignored_entries_alone_are_not_entries() {
        let dir = repo();
        let root = dir.path();
        let (mut sub, seen) = sub(root, true);
        sub.note(&root.join("target/debug/app.exe"), true, Instant::now());
        sub.flush();
        let change = &seen.lock().unwrap()[0];
        assert!(change.ignored && !change.entries && change.paths.is_empty());
    }

    #[test]
    fn a_flat_watch_sees_only_its_folder_ignored_or_not() {
        let dir = repo();
        let root = dir.path().join("src");
        let (mut sub, seen) = sub(&root, false);
        let now = Instant::now();
        sub.note(&root.join("main.rs"), false, now);
        sub.note(&root.join("debug.log"), false, now);
        sub.note(&root.join("gen/out.rs"), false, now);
        sub.note(&dir.path().join("README.md"), false, now);
        sub.flush();
        assert_eq!(seen.lock().unwrap()[0].paths, ["debug.log", "main.rs"]);
    }

    #[test]
    fn a_changed_gitignore_is_read_again() {
        let dir = repo();
        let root = dir.path();
        let (mut sub, _) = sub(root, true);
        assert!(!sub.is_ignored(&root.join("notes.txt")));
        std::fs::write(root.join(".gitignore"), "*.txt\n").unwrap();
        sub.note(&root.join(".gitignore"), false, Instant::now());
        assert!(sub.is_ignored(&root.join("notes.txt")));
    }

    #[test]
    fn a_batch_waits_for_quiet_but_not_forever() {
        let start = Instant::now();
        let mut batch = Batch::new(start);
        batch.last = start + Duration::from_millis(900);
        assert!(!batch.due(start + Duration::from_millis(950)));
        assert!(batch.due(start + MAX_WAIT));
    }

    #[test]
    fn watches_the_disk() {
        let dir = repo();
        let root = dir.path().to_path_buf();
        let watches = FolderWatches::default();
        let seen = Arc::new(Mutex::new(Vec::<FolderChange>::new()));
        let sink = seen.clone();
        let channel = Channel::new(move |body| {
            if let tauri::ipc::InvokeResponseBody::Json(json) = body {
                sink.lock().unwrap().push(serde_json::from_str(&json).unwrap());
            }
            Ok(())
        });
        let id = watches.watch("main".into(), root.clone(), true, channel).unwrap();
        std::thread::sleep(Duration::from_millis(100));
        std::fs::write(root.join("src/new.rs"), "x").unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if seen.lock().unwrap().iter().any(|c| c.paths.iter().any(|p| p == "src/new.rs")) {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let changes = seen.lock().unwrap().clone();
        assert!(changes.iter().any(|c| c.entries && c.dirs.contains(&"src".into())), "{changes:?}");
        watches.unwatch(id);
        assert!(watches.0.inner.lock().unwrap().counts.is_empty());
    }
}

