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
    pub worktrees: WorktreesSettings,
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
            worktrees: WorktreesSettings::default(),
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
    /// The window's columns, left to right (read by `src/layout/placement.ts`).
    /// Each appears once; the dock is always at one end.
    pub layout: Vec<LayoutColumn>,
}

impl Default for AppearanceSettings {
    fn default() -> Self {
        Self {
            theme: DEFAULT_THEME.into(),
            font_family: DEFAULT_FONT_FAMILY.into(),
            layout: LayoutColumn::DEFAULT.to_vec(),
        }
    }
}

/// A column of the window: the dock, a side panel, or the main chat column.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum LayoutColumn {
    Dock,
    /// The chats sidebar.
    Chats,
    Main,
    /// The tabs panel (the right sidebar by default).
    Tabs,
    Files,
}

impl LayoutColumn {
    pub const DEFAULT: [LayoutColumn; 5] = [
        LayoutColumn::Dock,
        LayoutColumn::Chats,
        LayoutColumn::Main,
        LayoutColumn::Tabs,
        LayoutColumn::Files,
    ];

    /// Each column once, the dock at an end; mirrored by `normalizeLayout`
    /// in `src/layout/placement.ts`. Duplicates keep their first place; a
    /// missing column goes beside the main one on its default side (the dock
    /// to its default end); no main column resets the whole layout.
    pub fn normalize(columns: &[LayoutColumn]) -> Vec<LayoutColumn> {
        use LayoutColumn::{Dock, Main};
        let mut out: Vec<LayoutColumn> = Vec::new();
        for &column in columns {
            if !out.contains(&column) {
                out.push(column);
            }
        }
        if !out.contains(&Main) {
            return Self::DEFAULT.to_vec();
        }
        let position = |out: &[LayoutColumn], column| out.iter().position(|&c| c == column).unwrap();
        let default_main = position(&Self::DEFAULT, Main);
        for (at, &column) in Self::DEFAULT.iter().enumerate() {
            if out.contains(&column) {
                continue;
            }
            let main = position(&out, Main);
            let index = match (column, at < default_main) {
                (Dock, true) => 0,
                (Dock, false) => out.len(),
                (_, true) => main,
                (_, false) => main + 1,
            };
            out.insert(index, column);
        }
        let dock = position(&out, Dock);
        if dock != 0 && dock != out.len() - 1 {
            let left_of_main = dock < position(&out, Main);
            out.remove(dock);
            if left_of_main {
                out.insert(0, Dock);
            } else {
                out.push(Dock);
            }
        }
        out
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
    pub go_back: String,
    pub go_forward: String,
}

impl Default for KeyboardSettings {
    fn default() -> Self {
        Self {
            open_settings: "Mod+,".into(),
            toggle_sidebar: "Mod+B".into(),
            toggle_right_sidebar: "Mod+Alt+B".into(),
            toggle_file_panel: "Mod+Shift+E".into(),
            go_back: "Mod+[".into(),
            go_forward: "Mod+]".into(),
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
    /// The plan's usage as a ring in the dock (`src/layout/DockUsage.tsx`).
    pub show_usage_in_dock: bool,
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

/// How a new worktree's branch is named.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum BranchNaming {
    /// `<branch_prefix>/<slug of the first prompt>`.
    #[default]
    Static,
    /// `<type>/<slug>`, the type (feat, fix, refactor, …) and slug written by
    /// the text generation model from the first prompt; guessed from its
    /// words when that fails.
    Semantic,
}

/// Chats started in a worktree of their own, read by `src-tauri/src/chat.rs`
/// as each is made; chats already in a worktree keep theirs.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct WorktreesSettings {
    /// The folder new worktrees go in, a subfolder each. Empty (or not an
    /// absolute path; a leading `~` is the home folder) uses
    /// `<data dir>/worktrees`.
    pub location: String,
    pub branch_naming: BranchNaming,
    /// With static naming, new branches are `<prefix>/<slug of the first
    /// prompt>`; empty, just the slug.
    pub branch_prefix: String,
    /// Deleting a worktree chat deletes its branch too, merged or not.
    pub delete_branch: bool,
}

impl Default for WorktreesSettings {
    fn default() -> Self {
        Self {
            location: String::new(),
            branch_naming: BranchNaming::Static,
            branch_prefix: "outcode".into(),
            delete_branch: false,
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
        appearance.layout = LayoutColumn::normalize(&appearance.layout);
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
        let worktrees = &mut settings.worktrees;
        worktrees.location = worktrees.location.trim().into();
        worktrees.branch_prefix = worktrees.branch_prefix.trim().trim_matches('/').into();
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
    fn layout_is_normalized() {
        use LayoutColumn::*;
        let layout = |value: Value| {
            Settings::sanitize(
                &Settings::default(),
                &json!({ "appearance": { "layout": value } }),
            )
            .appearance
            .layout
        };
        assert_eq!(
            layout(json!(["files", "tabs", "main", "chats", "dock"])),
            vec![Files, Tabs, Main, Chats, Dock]
        );
        // Duplicates keep their first place; missing columns go beside main.
        assert_eq!(
            layout(json!(["dock", "files", "files", "main"])),
            vec![Dock, Files, Chats, Main, Tabs]
        );
        // The dock moves to the end of its side.
        assert_eq!(
            layout(json!(["chats", "dock", "main", "tabs", "files"])),
            vec![Dock, Chats, Main, Tabs, Files]
        );
        assert_eq!(
            layout(json!(["chats", "main", "dock", "tabs", "files"])),
            vec![Chats, Main, Tabs, Files, Dock]
        );
        assert_eq!(layout(json!(["dock", "chats"])), LayoutColumn::DEFAULT.to_vec());
        // An unknown column keeps the previous layout.
        assert_eq!(
            layout(json!(["dock", "terminal", "main"])),
            LayoutColumn::DEFAULT.to_vec()
        );
    }

    #[test]
    fn version_is_always_current() {
        let s = Settings::sanitize(&Settings::default(), &json!({ "version": 99 }));
        assert_eq!(s.version, SETTINGS_VERSION);
    }
}
