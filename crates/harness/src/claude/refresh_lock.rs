//! Claude Code's OAuth refresh lock, waited out before Hive stops a Claude
//! process (after zeron's `refresh_lock`).
//!
//! A Claude.ai login's refresh token is single-use: each refresh rotates the
//! pair, and the CLI saves the new one to `.credentials.json` only once the
//! token endpoint answers. A CLI killed in between leaves a spent refresh
//! token (or a lock nobody holds), and the next CLI's turn fails with
//! `authentication_failed`. The login has always expired after the PC was
//! off for a few hours, so the first CLI Hive starts (often the short-lived
//! command probe, stopped as soon as `initialize` answers) is the one doing
//! the refresh.
//!
//! The CLI serialises refreshes across processes with a proper-lockfile
//! directory lock: `<config>/.oauth_refresh.lock` (2.1.x; its mtime bumped
//! every 5s while held), and older CLIs `<realpath(config)>.lock`.
//! [`settle`] waits while either is live. On EOF the CLI waits only 2s for
//! a refresh in flight, so stdin stays open until it has settled too.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use hive_proto::HarnessId;

const LOCK_NAME: &str = ".oauth_refresh.lock";
/// A holder bumps its lock every 5s; one untouched longer lost its holder.
const LIVE_WINDOW: Duration = Duration::from_secs(20);
const POLL: Duration = Duration::from_millis(150);
/// Longest wait before a Claude process is stopped anyway: the CLI's refresh
/// request times out at 30s, then it fetches the profile and saves.
pub(crate) const SETTLE_MAX: Duration = Duration::from_secs(40);

/// The folder the CLI keeps (and locks) its login in:
/// `CLAUDE_SECURESTORAGE_CONFIG_DIR`, else `CLAUDE_CONFIG_DIR`, else
/// `~/.claude`; Hive's own overrides first.
pub(crate) fn config_dir() -> Option<PathBuf> {
    let var = |name| crate::overrides::env_var(HarnessId::ClaudeCode, name);
    var("CLAUDE_SECURESTORAGE_CONFIG_DIR")
        .or_else(|| var("CLAUDE_CONFIG_DIR"))
        .map(PathBuf::from)
        .or_else(|| Some(crate::cli::home_dir()?.join(".claude")))
}

/// The current lock, then the legacy one.
fn lock_paths(config_dir: &Path) -> [PathBuf; 2] {
    let real = std::fs::canonicalize(config_dir).unwrap_or_else(|_| config_dir.to_path_buf());
    // `canonicalize` gives `\\?\C:\…` on Windows; the CLI's realpath doesn't.
    let real = strip_verbatim(real);
    let mut legacy = real.into_os_string();
    legacy.push(".lock");
    [config_dir.join(LOCK_NAME), PathBuf::from(legacy)]
}

fn strip_verbatim(path: PathBuf) -> PathBuf {
    match path.to_str().and_then(|s| s.strip_prefix(r"\\?\")) {
        Some(rest) if !rest.starts_with("UNC\\") => PathBuf::from(rest),
        _ => path,
    }
}

fn lock_age(path: &Path) -> Option<Duration> {
    let modified = std::fs::metadata(path).ok()?.modified().ok()?;
    Some(SystemTime::now().duration_since(modified).unwrap_or_default())
}

/// Whether a live Claude process is refreshing the login in `config_dir`.
fn refresh_in_flight(config_dir: &Path) -> bool {
    lock_paths(config_dir)
        .iter()
        .any(|path| lock_age(path).is_some_and(|age| age < LIVE_WINDOW))
}

/// Waits (at most [`SETTLE_MAX`]) until no Claude process is refreshing.
pub(crate) async fn settle() {
    let Some(dir) = config_dir() else {
        return;
    };
    settle_in(&dir, SETTLE_MAX).await;
}

/// `true` once idle; `false` when `max` ran out first.
async fn settle_in(config_dir: &Path, max: Duration) -> bool {
    let deadline = tokio::time::Instant::now() + max;
    while refresh_in_flight(config_dir) {
        if tokio::time::Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(POLL).await;
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn age(path: &Path, by: Duration) {
        let then = filetime::FileTime::from_system_time(SystemTime::now() - by);
        filetime::set_file_mtime(path, then).unwrap();
    }

    /// A fresh `claude` config folder under the temp dir.
    fn config(test: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("hive-refresh-lock-{test}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let config = root.join("claude");
        std::fs::create_dir_all(&config).unwrap();
        config
    }

    #[test]
    fn names_the_current_and_legacy_locks() {
        let config = config("names");
        let [current, legacy] = lock_paths(&config);
        assert_eq!(current, config.join(LOCK_NAME));
        assert!(legacy.to_string_lossy().ends_with("claude.lock"));
        assert!(!legacy.to_string_lossy().starts_with(r"\\?\"));
    }

    #[tokio::test]
    async fn waits_out_a_live_holder_only() {
        let config = config("waits");
        assert!(settle_in(&config, Duration::from_millis(100)).await);

        let [current, legacy] = lock_paths(&config);
        std::fs::create_dir(&current).unwrap();
        assert!(!settle_in(&config, Duration::from_millis(300)).await);
        // Its holder died: the lock stops being touched.
        age(&current, Duration::from_secs(30));
        assert!(settle_in(&config, Duration::from_millis(100)).await);

        std::fs::create_dir(&legacy).unwrap();
        assert!(refresh_in_flight(&config));
        let release = legacy.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(300)).await;
            std::fs::remove_dir(release).unwrap();
        });
        assert!(settle_in(&config, Duration::from_secs(5)).await);
    }
}
