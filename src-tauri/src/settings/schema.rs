//! The settings document, one JSON file (`settings.json`).
//!
//! Add a setting only once something reads it: a section struct
//! (`#[serde(rename_all = "camelCase", default)]` + `Default`) as a field of
//! [`Settings`], mirrored in `src/features/settings/types.ts`.
//!
//! Keep sections to plain leaves (bools, numbers, strings, enums, options):
//! [`Settings::sanitize`] applies input leaf by leaf and keeps each one only if
//! the document still deserializes, so a bad field falls back to its previous
//! value instead of failing the whole file.

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Bumped when a field changes meaning; new fields only need a default.
pub const SETTINGS_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub version: u32,
    pub updates: UpdatesSettings,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            version: SETTINGS_VERSION,
            updates: UpdatesSettings::default(),
        }
    }
}

/// Which releases the updater offers.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum UpdateChannel {
    /// The release GitHub marks as latest (pre-releases never are).
    #[default]
    Stable,
    /// The newest release, pre-releases included.
    Prerelease,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct UpdatesSettings {
    /// Look for a release at launch, every few hours and on window focus.
    pub auto_check: bool,
    pub channel: UpdateChannel,
}

impl Default for UpdatesSettings {
    fn default() -> Self {
        Self {
            auto_check: true,
            channel: UpdateChannel::Stable,
        }
    }
}

impl Settings {
    /// Arbitrary JSON in, a valid document out; never fails.
    pub fn sanitize(base: &Settings, input: &Value) -> Settings {
        let mut settings = sanitize(base, input);
        settings.version = SETTINGS_VERSION;
        settings
    }
}

/// `input` deep-merged onto `base`, one leaf at a time. Leaves that are
/// missing or would make `T` fail to deserialize keep their value from
/// `base`; unknown keys are dropped.
fn sanitize<T>(base: &T, input: &Value) -> T
where
    T: Serialize + DeserializeOwned + Clone,
{
    let mut doc = serde_json::to_value(base).expect("settings serialize");
    overlay::<T>(&mut doc, &mut String::new(), input);
    serde_json::from_value(doc).unwrap_or_else(|_| base.clone())
}

/// Copies `input` onto `doc` at JSON pointer `at`, reverting any leaf that
/// makes the document fail to deserialize as `T`.
fn overlay<T: DeserializeOwned>(doc: &mut Value, at: &mut String, input: &Value) {
    let Some(current) = doc.pointer(at).cloned() else {
        return;
    };
    match (current, input) {
        (Value::Object(fields), Value::Object(given)) => {
            for key in fields.keys() {
                if let Some(value) = given.get(key) {
                    let len = at.len();
                    at.push('/');
                    at.push_str(&key.replace('~', "~0").replace('/', "~1"));
                    overlay::<T>(doc, at, value);
                    at.truncate(len);
                }
            }
        }
        // A section replaced by a non-object: keep the section.
        (Value::Object(_), _) => {}
        (old, value) => {
            *doc.pointer_mut(at).unwrap() = value.clone();
            if serde_json::from_value::<T>(doc.clone()).is_err() {
                *doc.pointer_mut(at).unwrap() = old;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn missing_fields_keep_base() {
        assert_eq!(
            Settings::sanitize(&Settings::default(), &json!({})),
            Settings::default()
        );
    }

    #[test]
    fn invalid_leaves_fall_back_individually() {
        let s = Settings::sanitize(
            &Settings::default(),
            &json!({
                "updates": { "autoCheck": "no", "channel": "prerelease" },
                "unknown": 1,
            }),
        );
        assert!(s.updates.auto_check);
        assert_eq!(s.updates.channel, UpdateChannel::Prerelease);

        let s = Settings::sanitize(&Settings::default(), &json!({ "updates": "big" }));
        assert_eq!(s, Settings::default());
    }

    #[test]
    fn version_is_always_current() {
        let s = Settings::sanitize(&Settings::default(), &json!({ "version": 99 }));
        assert_eq!(s.version, SETTINGS_VERSION);
    }
}
