//! The user's per-CLI settings (Settings › Providers): which binary to run,
//! extra environment variables (a config folder among them) and extra launch
//! arguments. Set live from the app's settings with [`configure`]; every
//! spawn of that harness's CLI reads them.

use std::collections::HashMap;
use std::ffi::OsString;
use std::path::PathBuf;
use std::sync::{LazyLock, RwLock};

use hive_proto::{HarnessId, Settings};
use tokio::process::Command;

use crate::cli;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CliOverrides {
    /// Runs this instead of the CLI found on PATH.
    pub binary: Option<PathBuf>,
    /// Set on every process of the CLI.
    pub env: Vec<(String, String)>,
    /// Added to a chat run's command line (not to probes or sign-ins).
    pub args: Vec<String>,
}

static OVERRIDES: LazyLock<RwLock<HashMap<HarnessId, CliOverrides>>> =
    LazyLock::new(RwLock::default);

/// Replaces `harness`'s overrides.
pub fn set(harness: HarnessId, overrides: CliOverrides) {
    let mut all = OVERRIDES.write().unwrap_or_else(|e| e.into_inner());
    all.insert(harness, overrides);
}

pub(crate) fn get(harness: HarnessId) -> CliOverrides {
    let all = OVERRIDES.read().unwrap_or_else(|e| e.into_inner());
    all.get(&harness).cloned().unwrap_or_default()
}

/// Sets every harness's overrides from the settings document.
pub fn configure(settings: &Settings) {
    let claude = &settings.claude;
    let mut env = parse_env(&claude.env);
    put_dir(&mut env, "CLAUDE_CONFIG_DIR", &claude.config_dir);
    set(
        HarnessId::ClaudeCode,
        CliOverrides {
            binary: path(&claude.binary_path),
            env,
            args: split_args(&claude.launch_args),
        },
    );

    let codex = &settings.codex;
    let mut env = parse_env(&codex.env);
    put_dir(&mut env, "CODEX_HOME", &codex.home_path);
    set(
        HarnessId::Codex,
        CliOverrides {
            binary: path(&codex.binary_path),
            env,
            args: split_args(&codex.launch_args),
        },
    );

    let opencode = &settings.opencode;
    set(
        HarnessId::Opencode,
        CliOverrides {
            binary: path(&opencode.binary_path),
            env: parse_env(&opencode.env),
            args: split_args(&opencode.launch_args),
        },
    );

    let pi = &settings.pi;
    let mut env = parse_env(&pi.env);
    put_dir(&mut env, "PI_CODING_AGENT_DIR", &pi.agent_dir);
    set(
        HarnessId::Pi,
        CliOverrides {
            binary: path(&pi.binary_path),
            env,
            args: split_args(&pi.launch_args),
        },
    );
}

/// The binary the user picked, else `found()`. A picked one that doesn't
/// exist is none: the CLI shows as not installed rather than quietly
/// running another.
pub(crate) fn binary(harness: HarnessId, found: impl FnOnce() -> Option<PathBuf>) -> Option<PathBuf> {
    match get(harness).binary {
        Some(path) if path.is_file() => Some(path),
        // A bare name (`claude-beta`) is looked up on PATH.
        Some(path) if path.components().count() == 1 => cli::find_on_path(&path.to_string_lossy()),
        Some(_) => None,
        None => found(),
    }
}

/// `name` as the CLI sees it: the user's value, else Hive's own environment.
pub(crate) fn env_var(harness: HarnessId, name: &str) -> Option<OsString> {
    get(harness)
        .env
        .into_iter()
        .rev()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.into())
        .or_else(|| std::env::var_os(name))
        .filter(|v| !v.is_empty())
}

/// `cli::command(exe)` with `harness`'s environment variables set.
pub(crate) fn command(harness: HarnessId, exe: &std::path::Path) -> Command {
    let mut cmd = cli::command(exe);
    cmd.envs(get(harness).env);
    cmd
}

/// A path setting: `~` is the home folder; empty is none.
fn path(raw: &str) -> Option<PathBuf> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    match raw.strip_prefix('~') {
        Some(rest) if rest.is_empty() || rest.starts_with(['/', '\\']) => {
            Some(cli::home_dir()?.join(rest.trim_start_matches(['/', '\\'])))
        }
        _ => Some(PathBuf::from(raw)),
    }
}

/// A folder setting as an environment variable, over one typed in `env`.
fn put_dir(env: &mut Vec<(String, String)>, name: &str, raw: &str) {
    if let Some(dir) = path(raw) {
        env.retain(|(key, _)| key != name);
        env.push((name.to_owned(), dir.display().to_string()));
    }
}

/// `NAME=value` per line; blank lines and `#` comments skipped, `export `
/// and quotes around the value dropped, malformed names ignored.
pub fn parse_env(text: &str) -> Vec<(String, String)> {
    text.lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                return None;
            }
            let line = line.strip_prefix("export ").unwrap_or(line);
            let (name, value) = line.split_once('=')?;
            let name = name.trim();
            let valid = !name.is_empty()
                && !name.starts_with(|c: char| c.is_ascii_digit())
                && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
            if !valid {
                return None;
            }
            let value = value.trim();
            let value = [('"', '"'), ('\'', '\'')]
                .iter()
                .find_map(|(open, close)| {
                    value
                        .strip_prefix(*open)
                        .and_then(|v| v.strip_suffix(*close))
                })
                .unwrap_or(value);
            Some((name.to_owned(), value.to_owned()))
        })
        .collect()
}

/// Splits a command line like a POSIX shell would, minus expansions:
/// whitespace separates, quotes group, a backslash outside single quotes
/// escapes the next character.
pub fn split_args(text: &str) -> Vec<String> {
    let mut args = Vec::new();
    let mut current = String::new();
    let mut started = false;
    let mut quote: Option<char> = None;
    let mut chars = text.chars();
    while let Some(c) = chars.next() {
        match (quote, c) {
            (Some(q), c) if c == q => quote = None,
            (Some('\''), c) => current.push(c),
            (_, '\\') => {
                if let Some(next) = chars.next() {
                    current.push(next);
                }
                started = true;
            }
            (Some(_), c) => current.push(c),
            (None, '"' | '\'') => {
                quote = Some(c);
                started = true;
            }
            (None, c) if c.is_whitespace() => {
                if started {
                    args.push(std::mem::take(&mut current));
                    started = false;
                }
            }
            (None, c) => {
                current.push(c);
                started = true;
            }
        }
    }
    if started {
        args.push(current);
    }
    args
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn env_lines_are_parsed() {
        let env = parse_env(
            "# router\nexport ANTHROPIC_BASE_URL=https://x/api\nKEY=\"a b\"\n\n1BAD=x\nno equals\nEMPTY=\n",
        );
        assert_eq!(
            env,
            [
                ("ANTHROPIC_BASE_URL".into(), "https://x/api".into()),
                ("KEY".into(), "a b".into()),
                ("EMPTY".into(), String::new()),
            ]
        );
    }

    #[test]
    fn args_split_like_a_shell() {
        assert_eq!(
            split_args(r#"--chrome  --append-system-prompt "be brief" --x='a "b"' c\ d"#),
            ["--chrome", "--append-system-prompt", "be brief", r#"--x=a "b""#, "c d"]
        );
        assert_eq!(split_args(r#"-e """#), ["-e", ""]);
        assert!(split_args("   ").is_empty());
    }

    #[test]
    fn a_config_dir_wins_over_the_same_variable() {
        let mut env = parse_env("CODEX_HOME=/a");
        put_dir(&mut env, "CODEX_HOME", "/b");
        assert_eq!(env, [("CODEX_HOME".into(), "/b".into())]);
        put_dir(&mut env, "CODEX_HOME", "");
        assert_eq!(env, [("CODEX_HOME".into(), "/b".into())]);
    }
}
