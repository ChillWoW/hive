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
    pub appearance: AppearanceSettings,
    pub updates: UpdatesSettings,
    pub keyboard: KeyboardSettings,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            version: SETTINGS_VERSION,
            appearance: AppearanceSettings::default(),
            updates: UpdatesSettings::default(),
            keyboard: KeyboardSettings::default(),
        }
    }
}

pub const DEFAULT_THEME: &str = "Hive Slate";

/// Read by the frontend (`src/features/theme/`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppearanceSettings {
    /// A theme's name: a built-in one, or a file in `<data dir>/themes/`.
    /// One that no longer exists shows the default.
    pub theme: String,
}

impl Default for AppearanceSettings {
    fn default() -> Self {
        Self {
            theme: DEFAULT_THEME.into(),
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

/// Which key sends a prompt from the composer; the other one adds a line.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
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
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct KeyboardSettings {
    pub send_with: SendKey,
    /// Opens the command palette (chats, files, actions).
    pub command_palette: String,
    pub new_chat: String,
    pub toggle_sidebar: String,
    pub open_settings: String,
    pub open_usage: String,
    /// Opens the open chat's details card under the top bar's right corner.
    pub chat_details: String,
    pub focus_composer: String,
    pub previous_chat: String,
    pub next_chat: String,
    pub go_back: String,
    pub go_forward: String,
    /// Archives the open chat and moves on to the next one (unarchives an
    /// archived one).
    pub archive_chat: String,
    /// Opens the find bar over the open chat's transcript.
    pub find_in_chat: String,
    pub new_terminal: String,
    pub open_diff: String,
    pub open_history: String,
    pub toggle_file_panel: String,
    pub toggle_right_sidebar: String,
    /// Opens the file panel with its search field focused.
    pub search_files: String,
    /// Opens the file panel's search on the text inside files.
    pub search_in_files: String,
    /// Closes the right sidebar's shown tab.
    pub close_tab: String,
    /// Only while typing a prompt.
    pub toggle_plan: String,
    /// Only while typing a prompt: in the new-chat view, starts the chat but
    /// stays on the new-chat view; in a started chat, sends as usual.
    pub send_in_background: String,
}

impl Default for KeyboardSettings {
    fn default() -> Self {
        Self {
            send_with: SendKey::Enter,
            command_palette: "Mod+K".into(),
            new_chat: "Mod+N".into(),
            toggle_sidebar: "Mod+B".into(),
            open_settings: "Mod+,".into(),
            open_usage: "Mod+U".into(),
            chat_details: "Mod+I".into(),
            focus_composer: "Mod+L".into(),
            previous_chat: "Ctrl+Shift+Tab".into(),
            next_chat: "Ctrl+Tab".into(),
            go_back: "Alt+Left".into(),
            go_forward: "Alt+Right".into(),
            archive_chat: "Mod+Shift+A".into(),
            find_in_chat: "Mod+F".into(),
            new_terminal: "Mod+J".into(),
            open_diff: "Mod+Shift+G".into(),
            open_history: "Mod+Shift+H".into(),
            toggle_file_panel: "Mod+Shift+E".into(),
            toggle_right_sidebar: "Mod+Alt+B".into(),
            search_files: "Mod+P".into(),
            search_in_files: "Mod+Shift+F".into(),
            close_tab: "Mod+W".into(),
            toggle_plan: "Shift+Tab".into(),
            send_in_background: "Mod+Shift+Enter".into(),
        }
    }
}

impl Settings {
    /// Arbitrary JSON in, a valid document out; never fails.
    pub fn sanitize(base: &Settings, input: &Value) -> Settings {
        let mut settings = sanitize(base, input);
        settings.version = SETTINGS_VERSION;
        let theme = settings.appearance.theme.trim();
        settings.appearance.theme = if theme.is_empty() {
            DEFAULT_THEME.into()
        } else {
            theme.into()
        };
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
                "appearance": { "theme": 7 },
                "updates": { "autoCheck": "no", "channel": "prerelease" },
                "unknown": 1,
            }),
        );
        assert_eq!(s.appearance.theme, DEFAULT_THEME);
        assert!(s.updates.auto_check);
        assert_eq!(s.updates.channel, UpdateChannel::Prerelease);

        let s = Settings::sanitize(
            &Settings::default(),
            &json!({ "keyboard": { "sendWith": "shout", "newChat": "", "closeTab": 3 } }),
        );
        assert_eq!(s.keyboard.send_with, SendKey::Enter);
        assert_eq!(s.keyboard.new_chat, "");
        assert_eq!(s.keyboard.close_tab, "Mod+W");

        let s = Settings::sanitize(&Settings::default(), &json!({ "updates": "big" }));
        assert_eq!(s, Settings::default());
    }

    #[test]
    fn theme_is_trimmed_and_never_empty() {
        let s = Settings::sanitize(&Settings::default(), &json!({ "appearance": { "theme": " Ember " } }));
        assert_eq!(s.appearance.theme, "Ember");
        let s = Settings::sanitize(&s, &json!({ "appearance": { "theme": "  " } }));
        assert_eq!(s.appearance.theme, DEFAULT_THEME);
    }

    #[test]
    fn version_is_always_current() {
        let s = Settings::sanitize(&Settings::default(), &json!({ "version": 99 }));
        assert_eq!(s.version, SETTINGS_VERSION);
    }
}
