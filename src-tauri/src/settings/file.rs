//! `settings.json` in the data dir: the [`Settings`] document, readable and
//! hand-editable. Every write goes through [`Settings::sanitize`], so what
//! lands on disk is always a valid, complete document.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use serde_json::Value;

use super::Settings;

pub const SETTINGS_FILE: &str = "settings.json";

pub struct SettingsFile {
    path: PathBuf,
    current: Mutex<Settings>,
}

impl SettingsFile {
    /// Loads `dir/settings.json`, creating it with defaults if missing. A file
    /// that isn't JSON is moved aside to `settings.json.bak` rather than lost;
    /// a JSON file with bad fields keeps every field that is still valid.
    pub fn open(dir: impl AsRef<Path>) -> io::Result<Self> {
        let dir = dir.as_ref();
        fs::create_dir_all(dir)?;
        let path = dir.join(SETTINGS_FILE);

        let (settings, rewrite) = match fs::read_to_string(&path) {
            Ok(text) => match serde_json::from_str::<Value>(&text) {
                Ok(raw) => {
                    let settings = Settings::sanitize(&Settings::default(), &raw);
                    // Rewrite only if sanitizing changed something, so a
                    // hand-edited file keeps its formatting otherwise.
                    let changed = serde_json::to_value(&settings)? != raw;
                    (settings, changed)
                }
                Err(_) => {
                    fs::rename(&path, path.with_extension("json.bak"))?;
                    (Settings::default(), true)
                }
            },
            Err(e) if e.kind() == io::ErrorKind::NotFound => (Settings::default(), true),
            Err(e) => return Err(e),
        };

        if rewrite {
            write_atomic(&path, &settings)?;
        }
        Ok(Self {
            path,
            current: Mutex::new(settings),
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    fn lock(&self) -> MutexGuard<'_, Settings> {
        self.current.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn get(&self) -> Settings {
        self.lock().clone()
    }

    /// Deep-merges `patch` (a partial document) and saves. Invalid leaves are
    /// ignored; returns what was stored, and whether it changed.
    pub fn update(&self, patch: &Value) -> io::Result<(Settings, bool)> {
        let mut current = self.lock();
        let next = Settings::sanitize(&current, patch);
        self.replace(&mut current, next)
    }

    pub fn reset(&self) -> io::Result<(Settings, bool)> {
        let mut current = self.lock();
        self.replace(&mut current, Settings::default())
    }

    /// Re-reads the file, for edits made outside the app.
    pub fn reload(&self) -> io::Result<(Settings, bool)> {
        let mut current = self.lock();
        let raw: Value = serde_json::from_str(&fs::read_to_string(&self.path)?)?;
        let next = Settings::sanitize(&Settings::default(), &raw);
        if next == *current {
            return Ok((next, false));
        }
        *current = next.clone();
        Ok((next, true))
    }

    fn replace(&self, current: &mut Settings, next: Settings) -> io::Result<(Settings, bool)> {
        if next == *current {
            return Ok((next, false));
        }
        write_atomic(&self.path, &next)?;
        *current = next.clone();
        Ok((next, true))
    }
}

/// Write-then-rename, so a crash mid-write never leaves half a file.
fn write_atomic(path: &Path, settings: &Settings) -> io::Result<()> {
    let tmp = path.with_extension("json.tmp");
    let mut text = serde_json::to_string_pretty(settings)?;
    text.push('\n');
    fs::write(&tmp, text)?;
    fs::rename(&tmp, path)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("hive-settings-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn creates_updates_and_reloads() {
        let dir = temp_dir("roundtrip");
        let file = SettingsFile::open(&dir).unwrap();
        assert_eq!(file.get(), Settings::default());
        assert!(file.path().exists());

        let (s, changed) = file.update(&json!({ "updates": { "autoCheck": false } })).unwrap();
        assert!(changed && !s.updates.auto_check);
        assert_eq!(SettingsFile::open(&dir).unwrap().get(), s);

        fs::write(file.path(), r#"{ "updates": { "channel": "prerelease" } }"#).unwrap();
        let (s, changed) = file.reload().unwrap();
        assert!(changed && s.updates.auto_check);
        assert_eq!(s.updates.channel, super::super::UpdateChannel::Prerelease);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn non_json_is_moved_aside() {
        let dir = temp_dir("corrupt");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(SETTINGS_FILE), "not json").unwrap();
        let file = SettingsFile::open(&dir).unwrap();
        assert_eq!(file.get(), Settings::default());
        assert!(dir.join("settings.json.bak").exists());
        let _ = fs::remove_dir_all(&dir);
    }
}
