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

use outcode_proto::{AccessMode, ReasoningLevel};
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
    pub claude: ClaudeSettings,
    pub chat: ChatSettings,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            version: SETTINGS_VERSION,
            appearance: AppearanceSettings::default(),
            updates: UpdatesSettings::default(),
            keyboard: KeyboardSettings::default(),
            claude: ClaudeSettings::default(),
            chat: ChatSettings::default(),
        }
    }
}

pub const DEFAULT_THEME: &str = "Outcode Slate";
/// Bundled with the frontend, so always available.
pub const DEFAULT_FONT_FAMILY: &str = "Geist";

/// Read by the frontend (`src/features/theme/`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppearanceSettings {
    /// A theme's name: a built-in one, or a file in `<data dir>/themes/`.
    /// One that no longer exists shows the default.
    pub theme: String,
    /// The interface font's family name: the bundled default or an installed
    /// one. One that isn't installed falls back to the system UI font.
    pub font_family: String,
}

impl Default for AppearanceSettings {
    fn default() -> Self {
        Self {
            theme: DEFAULT_THEME.into(),
            font_family: DEFAULT_FONT_FAMILY.into(),
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

/// Shortcuts, read by the frontend's keybinding layer (`src/keybindings/`).
/// Each is a combo like `"Mod+Shift+P"` (`Mod`: Cmd on macOS, Ctrl
/// elsewhere); an empty string leaves the action unbound. A combo the
/// frontend can't parse is treated as unbound.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct KeyboardSettings {
    pub open_settings: String,
    pub toggle_sidebar: String,
    pub toggle_right_sidebar: String,
    pub toggle_file_panel: String,
}

impl Default for KeyboardSettings {
    fn default() -> Self {
        Self {
            open_settings: "Mod+,".into(),
            toggle_sidebar: "Mod+B".into(),
            toggle_right_sidebar: "Mod+Alt+B".into(),
            toggle_file_panel: "Mod+Shift+E".into(),
        }
    }
}

/// Claude Code, read by `src-tauri/src/chat.rs` and the frontend's new-chat
/// config (`src/features/chat/config.ts`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ClaudeSettings {
    /// The `claude` executable to run. Empty: found on PATH or where its
    /// installers put it.
    pub binary_path: String,
    /// What a new chat's agent may do without asking.
    pub default_access: AccessMode,
    /// The context size, in tokens, Claude compacts the conversation at; 0
    /// keeps its own default. Applies to runs started after a change.
    pub auto_compact_window: u32,
    /// Extra arguments for every chat's `claude`, split like a shell would.
    pub launch_args: String,
    /// Extra environment variables for every `claude`, as `KEY=value` lines.
    pub env: String,
    /// The folder Claude keeps its settings and login in (`CLAUDE_CONFIG_DIR`);
    /// empty: its own (`~/.claude`).
    pub config_dir: String,
}

/// Chats: their runs, read by `src-tauri/src/chat.rs`, and the defaults the
/// frontend's new-chat config starts from (`src/features/chat/config.ts`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ChatSettings {
    /// The model a new chat starts on (a catalog id).
    pub default_model: String,
    /// The effort a new chat starts at, where its model takes one.
    pub default_effort: ReasoningLevel,
    /// New chats on a model with fast mode start with it on.
    pub default_fast_mode: bool,
    /// Minutes a chat's agent process is kept between prompts before it's
    /// closed; the next prompt starts a new one that resumes the session.
    pub idle_timeout_minutes: u32,
    /// Name a chat with a short text run on its first prompt; off, its
    /// first words name it.
    pub auto_title: bool,
    /// The model for text runs (chat titles and other short labels): a
    /// Claude alias or id; empty: Claude's default.
    pub text_generation_model: String,
    /// Thinking blocks start expanded in the transcript.
    pub reasoning_expanded: bool,
    /// Tool rows start expanded, showing their output.
    pub tool_output_expanded: bool,
    /// What sending does while a turn runs: wait for it, stop it after the
    /// running tool call, or stop it now.
    pub busy_send: BusySend,
}

/// What sending a prompt does while the chat's turn runs.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum BusySend {
    /// Queue it; it goes once the turn ends.
    #[default]
    Queue,
    /// Stop the turn once its running tool calls finish, and send it.
    AfterTool,
    /// Stop the turn and send it now.
    Interrupt,
}

impl Default for ChatSettings {
    fn default() -> Self {
        Self {
            default_model: "claude-opus-5-5".into(),
            default_effort: ReasoningLevel::High,
            default_fast_mode: false,
            idle_timeout_minutes: 15,
            auto_title: true,
            text_generation_model: "haiku".into(),
            reasoning_expanded: false,
            tool_output_expanded: false,
            busy_send: BusySend::Queue,
        }
    }
}

impl Settings {
    /// Arbitrary JSON in, a valid document out; never fails.
    pub fn sanitize(base: &Settings, input: &Value) -> Settings {
        let mut settings = sanitize(base, input);
        settings.version = SETTINGS_VERSION;
        let appearance = &mut settings.appearance;
        appearance.theme = non_empty(&appearance.theme, DEFAULT_THEME);
        appearance.font_family = non_empty(&appearance.font_family, DEFAULT_FONT_FAMILY);
        settings.claude.binary_path = settings.claude.binary_path.trim().into();
        settings.claude.config_dir = settings.claude.config_dir.trim().into();
        settings.claude.launch_args = settings.claude.launch_args.trim().into();
        let window = &mut settings.claude.auto_compact_window;
        if *window != 0 {
            *window = (*window).clamp(10_000, 2_000_000);
        }
        let model = &mut settings.chat.default_model;
        *model = non_empty(model, &ChatSettings::default().default_model);
        let idle = &mut settings.chat.idle_timeout_minutes;
        *idle = (*idle).clamp(1, 24 * 60);
        let model = &mut settings.chat.text_generation_model;
        *model = model.trim().into();
        settings
    }
}

/// `value` trimmed, or `fallback` when that leaves nothing.
fn non_empty(value: &str, fallback: &str) -> String {
    match value.trim() {
        "" => fallback.into(),
        trimmed => trimmed.into(),
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
            &json!({ "keyboard": { "openSettings": 3 } }),
        );
        assert_eq!(s.keyboard.open_settings, "Mod+,");
        let s = Settings::sanitize(
            &Settings::default(),
            &json!({ "keyboard": { "openSettings": "" } }),
        );
        assert_eq!(s.keyboard.open_settings, "");

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
    fn font_family_is_trimmed_and_never_empty() {
        let s = Settings::sanitize(
            &Settings::default(),
            &json!({ "appearance": { "fontFamily": " Inter " } }),
        );
        assert_eq!(s.appearance.font_family, "Inter");
        let s = Settings::sanitize(&s, &json!({ "appearance": { "fontFamily": "" } }));
        assert_eq!(s.appearance.font_family, DEFAULT_FONT_FAMILY);
    }

    #[test]
    fn version_is_always_current() {
        let s = Settings::sanitize(&Settings::default(), &json!({ "version": 99 }));
        assert_eq!(s.version, SETTINGS_VERSION);
    }
}
