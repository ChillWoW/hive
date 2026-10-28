//! App settings: one JSON document, owned by `hive-store`'s `SettingsFile`.
//!
//! Add a setting only once something reads it: a section
//! struct (`#[serde(rename_all = "camelCase", default)]` + `Default`) as a field
//! of [`Settings`], then a row on a page in `src/settings/pages/`.
//!
//! Keep sections to plain leaves (bools, numbers, strings, enums, options).
//! [`sanitize`] relies on that shape: it applies input leaf by leaf and keeps
//! each one only if the document still deserializes, so a bad field falls back
//! to its previous value instead of failing the whole file. Nested maps or
//! lists would need their own handling there. Clamp ranges in
//! [`Settings::normalize`].

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

/// Bumped when a field changes meaning; new fields only need a default.
pub const SETTINGS_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub version: u32,
    pub chats: ChatsSettings,
    pub notifications: NotificationsSettings,
    pub keyboard: KeyboardSettings,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            version: SETTINGS_VERSION,
            chats: ChatsSettings::default(),
            notifications: NotificationsSettings::default(),
            keyboard: KeyboardSettings::default(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", default)]
pub struct ChatsSettings {
    /// At launch, send turns that Hive closed mid-run back to their agent to
    /// finish. Off by default: it spends tokens unasked.
    pub resume_interrupted: bool,
    /// Name new chats with a short model run after their first turn. Off, the
    /// first prompt's opening words name them instead.
    pub auto_title: bool,
}

impl Default for ChatsSettings {
    fn default() -> Self {
        Self {
            resume_interrupted: false,
            auto_title: true,
        }
    }
}

/// Read by the frontend (`src/notifications/`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", default)]
pub struct NotificationsSettings {
    /// A system notification when a turn finishes or fails while the window
    /// isn't focused.
    pub turn_finished: bool,
    /// A system notification when an agent asks a question or for approval
    /// while the window isn't focused.
    pub needs_input: bool,
    /// A chime when an agent asks a question or for approval.
    pub input_sound: bool,
    /// A chime when a turn finishes or fails.
    pub finished_sound: bool,
    /// The number of unseen chats on the taskbar / dock icon.
    pub badge: bool,
}

impl Default for NotificationsSettings {
    fn default() -> Self {
        Self {
            turn_finished: true,
            needs_input: true,
            input_sound: true,
            finished_sound: true,
            badge: true,
        }
    }
}

/// Which key sends a prompt from the composer; the other one adds a line.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum SendKey {
    #[default]
    Enter,
    /// Cmd+Enter on macOS, Ctrl+Enter elsewhere.
    ModEnter,
}

/// Shortcuts, read by the frontend's keybinding layer (`src/keybindings/`).
/// Each is a combo like `"Mod+Shift+P"` (`Mod`: Cmd on macOS, Ctrl
/// elsewhere); an empty string leaves the action unbound. A combo the
/// frontend can't parse is treated as unbound.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", default)]
pub struct KeyboardSettings {
    pub send_with: SendKey,
    pub new_chat: String,
    pub toggle_sidebar: String,
    pub open_settings: String,
    pub focus_composer: String,
    pub previous_chat: String,
    pub next_chat: String,
    pub go_back: String,
    pub go_forward: String,
    /// Only while typing a prompt.
    pub toggle_plan: String,
}

impl Default for KeyboardSettings {
    fn default() -> Self {
        Self {
            send_with: SendKey::Enter,
            new_chat: "Mod+N".into(),
            toggle_sidebar: "Mod+B".into(),
            open_settings: "Mod+,".into(),
            focus_composer: "Mod+L".into(),
            previous_chat: "Ctrl+Shift+Tab".into(),
            next_chat: "Ctrl+Tab".into(),
            go_back: "Alt+Left".into(),
            go_forward: "Alt+Right".into(),
            toggle_plan: "Shift+Tab".into(),
        }
    }
}

impl Settings {
    /// Arbitrary JSON in, a valid document out; never fails. See [`sanitize`].
    pub fn sanitize(base: &Settings, input: &Value) -> Settings {
        let mut settings = sanitize(base, input);
        settings.normalize();
        settings
    }

    /// Clamps values the types alone can't constrain.
    pub fn normalize(&mut self) {
        self.version = SETTINGS_VERSION;
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

    /// Stand-in schema with the shapes real sections will have.
    #[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase", default)]
    struct Doc {
        section: Section,
    }

    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase", default)]
    struct Section {
        flag: bool,
        count: u16,
        mode: Mode,
        path: Option<String>,
    }

    #[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
    #[serde(rename_all = "kebab-case")]
    enum Mode {
        One,
        Two,
    }

    impl Default for Section {
        fn default() -> Self {
            Self {
                flag: true,
                count: 3,
                mode: Mode::One,
                path: Some("/bin/x".into()),
            }
        }
    }

    #[test]
    fn missing_fields_keep_base() {
        assert_eq!(sanitize(&Doc::default(), &json!({})), Doc::default());
    }

    #[test]
    fn invalid_leaves_fall_back_individually() {
        let s = sanitize(
            &Doc::default(),
            &json!({
                "section": { "flag": "yes", "count": -1, "mode": "two" },
                "unknown": 1,
            }),
        );
        assert!(s.section.flag);
        assert_eq!(s.section.count, 3);
        assert_eq!(s.section.mode, Mode::Two);

        let s = sanitize(&Doc::default(), &json!({ "section": "big" }));
        assert_eq!(s, Doc::default());
    }

    #[test]
    fn options_can_be_cleared() {
        let s = sanitize(&Doc::default(), &json!({ "section": { "path": null } }));
        assert_eq!(s.section.path, None);
    }

    #[test]
    fn settings_version_is_always_current() {
        let s = Settings::sanitize(&Settings::default(), &json!({ "version": 99 }));
        assert_eq!(s.version, SETTINGS_VERSION);
    }
}
