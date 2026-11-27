//! Tells the page when a chat folder's files change, so the file tree and
//! its git marks follow the disk: one recursive watch per folder, its events
//! settled into one message a burst. What `.gitignore` hides is left out, as
//! a build writing into `target/` changes nothing the tree shows. A webview's
//! watches end when its page reloads, since their channels die with it.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::time::{Duration, Instant};

use ignore::Match;
use ignore::gitignore::{Gitignore, GitignoreBuilder};
use notify::event::{EventKind, ModifyKind};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use tauri::ipc::Channel;
use tauri::{State, Webview};

/// How long after a change the page hears of it, with what else came meanwhile.
const SETTLE: Duration = Duration::from_millis(150);

struct Watch {
    /// The webview that opened it.
    owner: String,
    /// Dropping it ends the watch, and with it the thread reading its events.
    _watcher: RecommendedWatcher,
}

/// The folders being watched, by watch id.
#[derive(Default)]
pub struct FileWatches {
    next: AtomicU32,
    live: Mutex<HashMap<u32, Watch>>,
}

impl FileWatches {
    /// Ends the watches `owner` opened.
    pub fn stop_owned_by(&self, owner: &str) {
        self.live.lock().unwrap().retain(|_, watch| watch.owner != owner);
    }
}

/// What `.gitignore` and `.ignore` files hide under a folder, each read once
/// and again after one of them changes. Close to what the listing's walk
/// hides: git's own excludes aren't read, so those count as shown.
struct Ignores {
    root: PathBuf,
    by_dir: HashMap<PathBuf, Option<Gitignore>>,
}

impl Ignores {
    fn new(root: PathBuf) -> Self {
        Self { root, by_dir: HashMap::new() }
    }

    fn load(dir: &Path) -> Option<Gitignore> {
        let mut builder = GitignoreBuilder::new(dir);
        builder.add(dir.join(".gitignore"));
        builder.add(dir.join(".ignore"));
        builder.build().ok().filter(|rules| !rules.is_empty())
    }

    /// Whether `path` (under the root) or a folder above it is ignored; the
    /// rules nearest to it speak first.
    fn hides(&mut self, path: &Path, is_dir: bool) -> bool {
        let mut dir = path.parent();
        while let Some(at) = dir.filter(|at| at.starts_with(&self.root)) {
            let rules = self.by_dir.entry(at.to_path_buf()).or_insert_with(|| Self::load(at));
            if let Some(rules) = rules {
                match rules.matched_path_or_any_parents(path, is_dir) {
                    Match::Ignore(_) => return true,
                    Match::Whitelist(_) => return false,
                    Match::None => {}
                }
            }
            dir = at.parent();
        }
        false
    }

    /// What an event means to the page: `Some(true)` when the tree's entries
    /// may have changed, `Some(false)` when only a listed file's text did,
    /// `None` when nothing it shows did.
    fn weigh(&mut self, event: &notify::Result<notify::Event>) -> Option<bool> {
        // Events were lost: anything may have changed.
        let Ok(event) = event else { return Some(true) };
        if event.need_rescan() {
            return Some(true);
        }
        let listing = match event.kind {
            EventKind::Access(_) => return None,
            EventKind::Create(_) | EventKind::Remove(_) | EventKind::Modify(ModifyKind::Name(_)) => true,
            _ => false,
        };
        let mut weight = None;
        for path in &event.paths {
            let Ok(inside) = path.strip_prefix(&self.root) else { continue };
            if inside.as_os_str().is_empty() || inside.components().any(|part| part.as_os_str() == ".git") {
                continue;
            }
            if path.file_name().is_some_and(|name| name == ".gitignore" || name == ".ignore") {
                self.by_dir.clear();
                return Some(true);
            }
            // An ignored folder's own row is listed; what's inside it isn't.
            let deep = path.parent().is_some_and(|parent| parent != self.root && self.hides(parent, true));
            if deep {
                continue;
            }
            if listing {
                return Some(true);
            }
            // An ignored file's text shows nowhere.
            if !self.hides(path, false) {
                weight = Some(false);
            }
        }
        weight
    }
}

/// Reads the watch's events until it ends or the page is gone, sending one
/// message [`SETTLE`] after the first change of a burst.
fn pump(root: PathBuf, events: Receiver<notify::Result<notify::Event>>, on_change: Channel<bool>) {
    let mut ignores = Ignores::new(root);
    // What to send, and when.
    let mut due: Option<(bool, Instant)> = None;
    loop {
        let event = match due {
            None => match events.recv() {
                Ok(event) => event,
                Err(_) => return,
            },
            Some((listing, at)) => match events.recv_timeout(at.saturating_duration_since(Instant::now())) {
                Ok(event) => event,
                Err(RecvTimeoutError::Timeout) => {
                    if on_change.send(listing).is_err() {
                        return;
                    }
                    due = None;
                    continue;
                }
                Err(RecvTimeoutError::Disconnected) => return,
            },
        };
        if let Some(listing) = ignores.weigh(&event) {
            due = Some(match due {
                Some((before, at)) => (before || listing, at),
                None => (listing, Instant::now() + SETTLE),
            });
        }
    }
}

/// Watches the folder `cwd`: `on_change` hears of each burst of changes
/// under it, `true` when files or folders came, went or moved, `false` when
/// only a file's text changed. Returns the watch's id, for `files_unwatch`.
#[tauri::command]
pub async fn files_watch(
    webview: Webview,
    watches: State<'_, FileWatches>,
    cwd: String,
    on_change: Channel<bool>,
) -> Result<u32, String> {
    let root = PathBuf::from(cwd);
    if !root.is_dir() {
        return Err(format!("{} is not a folder", root.display()));
    }
    let (send, events) = std::sync::mpsc::channel();
    let mut watcher = notify::recommended_watcher(send).map_err(|e| e.to_string())?;
    watcher.watch(&root, RecursiveMode::Recursive).map_err(|e| e.to_string())?;
    std::thread::Builder::new()
        .name("file-watch".into())
        .spawn(move || pump(root, events, on_change))
        .map_err(|e| e.to_string())?;
    let id = watches.next.fetch_add(1, Ordering::Relaxed);
    watches.live.lock().unwrap().insert(
        id,
        Watch {
            owner: webview.label().to_owned(),
            _watcher: watcher,
        },
    );
    Ok(id)
}

#[tauri::command]
pub fn files_unwatch(watches: State<'_, FileWatches>, id: u32) {
    watches.live.lock().unwrap().remove(&id);
}

#[cfg(test)]
mod tests {
    use notify::Event;
    use notify::event::{CreateKind, DataChange};

    use super::*;

    fn event(kind: EventKind, path: &Path) -> notify::Result<Event> {
        Ok(Event::new(kind).add_path(path.to_path_buf()))
    }

    #[test]
    fn only_what_the_tree_shows_counts() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::write(root.join(".gitignore"), "target/\n*.log\n").unwrap();
        std::fs::create_dir_all(root.join("target/debug")).unwrap();
        std::fs::create_dir_all(root.join("src")).unwrap();
        let mut ignores = Ignores::new(root.to_path_buf());
        let create = EventKind::Create(CreateKind::Any);
        let write = EventKind::Modify(ModifyKind::Data(DataChange::Any));

        assert_eq!(ignores.weigh(&event(create, &root.join("src/new.rs"))), Some(true));
        assert_eq!(ignores.weigh(&event(write, &root.join("src/new.rs"))), Some(false));
        // An ignored folder's row is listed, what's inside it isn't.
        assert_eq!(ignores.weigh(&event(create, &root.join("target"))), Some(true));
        assert_eq!(ignores.weigh(&event(create, &root.join("target/debug/app.exe"))), None);
        assert_eq!(ignores.weigh(&event(create, &root.join("target/debug"))), None);
        // An ignored file is listed too, but its text shows nowhere.
        assert_eq!(ignores.weigh(&event(create, &root.join("out.log"))), Some(true));
        assert_eq!(ignores.weigh(&event(write, &root.join("out.log"))), None);
        assert_eq!(ignores.weigh(&event(write, &root.join(".git/index"))), None);
        assert_eq!(ignores.weigh(&event(write, &root.join(".gitignore"))), Some(true));
    }
}
