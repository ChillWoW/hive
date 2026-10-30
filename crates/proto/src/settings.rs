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

use crate::agent::{HarnessId, ReasoningLevel};

/// Bumped when a field changes meaning; new fields only need a default.
pub const SETTINGS_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub version: u32,
    pub chats: ChatsSettings,
    pub text_generation: TextGenerationSettings,
    pub worktrees: WorktreesSettings,
    pub notifications: NotificationsSettings,
    pub keyboard: KeyboardSettings,
    pub providers: ProvidersSettings,
    pub updates: UpdatesSettings,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            version: SETTINGS_VERSION,
            chats: ChatsSettings::default(),
            text_generation: TextGenerationSettings::default(),
            worktrees: WorktreesSettings::default(),
            notifications: NotificationsSettings::default(),
            keyboard: KeyboardSettings::default(),
            providers: ProvidersSettings::default(),
            updates: UpdatesSettings::default(),
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

/// The model behind Hive's own short text runs (chat titles, for now). Read
/// by the engine, live (`src-tauri/src/settings.rs`). No harness means
/// automatic: the chat's own harness (else the first installed one that can),
/// its smallest model at its lowest effort. A picked harness that isn't
/// installed falls back to automatic too.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", default)]
pub struct TextGenerationSettings {
    pub harness: Option<HarnessId>,
    /// None, or one the harness no longer lists: its smallest model.
    pub model: Option<String>,
    /// None, or a level the model lacks: its lowest.
    pub reasoning: Option<ReasoningLevel>,
}

/// Chats started in a worktree of their own. Read by the engine, live
/// (`src-tauri/src/settings.rs`); chats already in a worktree keep theirs.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", default)]
pub struct WorktreesSettings {
    /// The folder new worktrees go in, a subfolder each. Empty (or not an
    /// absolute path; a leading `~` is the home folder) uses
    /// `<data dir>/worktrees`.
    pub location: String,
    /// New branches are `<prefix>/<slug of the first prompt>`; empty, just
    /// the slug.
    pub branch_prefix: String,
    /// Deleting a worktree chat deletes its branch too, merged or not.
    pub delete_branch: bool,
}

impl Default for WorktreesSettings {
    fn default() -> Self {
        Self {
            location: String::new(),
            branch_prefix: "hive".into(),
            delete_branch: false,
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
    /// Opens the command palette (chats, files, actions).
    pub command_palette: String,
    pub new_chat: String,
    pub toggle_sidebar: String,
    pub open_settings: String,
    pub open_usage: String,
    pub focus_composer: String,
    pub previous_chat: String,
    pub next_chat: String,
    pub go_back: String,
    pub go_forward: String,
    pub new_terminal: String,
    pub open_diff: String,
    pub open_history: String,
    pub toggle_file_panel: String,
    pub toggle_right_sidebar: String,
    /// Opens the file panel with its search field focused.
    pub search_files: String,
    /// Closes the right sidebar's shown tab.
    pub close_tab: String,
    /// Only while typing a prompt.
    pub toggle_plan: String,
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
            focus_composer: "Mod+L".into(),
            previous_chat: "Ctrl+Shift+Tab".into(),
            next_chat: "Ctrl+Tab".into(),
            go_back: "Alt+Left".into(),
            go_forward: "Alt+Right".into(),
            new_terminal: "Mod+J".into(),
            open_diff: "Mod+Shift+G".into(),
            open_history: "Mod+Shift+H".into(),
            toggle_file_panel: "Mod+Shift+E".into(),
            toggle_right_sidebar: "Mod+Alt+B".into(),
            search_files: "Mod+P".into(),
            close_tab: "Mod+W".into(),
            toggle_plan: "Shift+Tab".into(),
        }
    }
}

/// Which harnesses the pickers offer, one switch per registered harness, keyed
/// by its id in camelCase. Read by the frontend (`src/harnesses/`); chats
/// already on a turned-off harness keep running on it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", default)]
pub struct ProvidersSettings {
    pub claude_code: bool,
    pub codex: bool,
    pub opencode: bool,
    pub mock: bool,
}

impl Default for ProvidersSettings {
    fn default() -> Self {
        Self {
            claude_code: true,
            codex: true,
            opencode: true,
            mock: true,
        }
    }
}

/// Which releases the updater offers.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
pub enum UpdateChannel {
    /// The release GitHub marks as latest (pre-releases never are).
    #[default]
    Stable,
    /// The newest release, pre-releases included.
    Prerelease,
}

/// App updates. `auto_check` is read by the frontend (`src/updater/`), the
/// channel by `update_check` (`src-tauri/src/updater.rs`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", default)]
pub struct UpdatesSettings {
    /// Look for a release at launch, every few hours and on window focus.
    /// Off, only Check now on Settings › About does.
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
    /// Arbitrary JSON in, a valid document out; never fails. See [`sanitize`].
    pub fn sanitize(base: &Settings, input: &Value) -> Settings {
        let mut settings = sanitize(base, input);
        settings.normalize();
        settings
    }

    /// Clamps values the types alone can't constrain.
    pub fn normalize(&mut self) {
        self.version = SETTINGS_VERSION;
        let worktrees = &mut self.worktrees;
        worktrees.location = worktrees.location.trim().to_owned();
        worktrees.branch_prefix = worktrees
            .branch_prefix
            .trim()
            .trim_matches('/')
            .trim()
            .to_owned();
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
    fn worktree_settings_are_trimmed() {
        let s = Settings::sanitize(
            &Settings::default(),
            &json!({ "worktrees": { "location": "  D:\\wt ", "branchPrefix": " /me/ " } }),
        );
        assert_eq!(s.worktrees.location, "D:\\wt");
        assert_eq!(s.worktrees.branch_prefix, "me");
    }

    #[test]
    fn text_generation_is_set_and_cleared_leaf_by_leaf() {
        let pick = json!({ "textGeneration": {
            "harness": "codex", "model": "gpt-5-mini", "reasoning": "nope"
        } });
        let s = Settings::sanitize(&Settings::default(), &pick);
        let text = &s.text_generation;
        assert_eq!(text.harness, Some(HarnessId::Codex));
        assert_eq!(text.model.as_deref(), Some("gpt-5-mini"));
        assert_eq!(text.reasoning, None);
        let cleared = json!({ "textGeneration": { "harness": null, "model": null } });
        let s = Settings::sanitize(&s, &cleared);
        assert_eq!(s.text_generation, TextGenerationSettings::default());
    }

    #[test]
    fn settings_version_is_always_current() {
        let s = Settings::sanitize(&Settings::default(), &json!({ "version": 99 }));
        assert_eq!(s.version, SETTINGS_VERSION);
    }
}
