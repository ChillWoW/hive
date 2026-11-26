//! The user's extra settings for every `claude` the app starts (Settings ›
//! Claude › Advanced): environment variables, a config folder
//! (`CLAUDE_CONFIG_DIR`) and launch arguments. Set live from the app's
//! settings with [`configure`]; each spawn reads them.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, RwLock};

use tokio::process::Command;

use crate::cli;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct Overrides {
    /// Set on every process of the CLI.
    env: Vec<(String, String)>,
    /// Added to a chat run's command line (not to probes, text runs or sign-ins).
    args: Vec<String>,
}

static OVERRIDES: LazyLock<RwLock<Overrides>> = LazyLock::new(RwLock::default);

fn get() -> Overrides {
    OVERRIDES.read().unwrap_or_else(|e| e.into_inner()).clone()
}

/// Sets what every later `claude` runs with: `env` as `KEY=value` lines
/// (blank lines and `#` comments skipped), `config_dir` as
/// `CLAUDE_CONFIG_DIR` (empty: the CLI's own), `launch_args` split like a
/// shell would.
pub fn configure(env: &str, config_dir: &str, launch_args: &str) {
    let mut vars = parse_env(env);
    let dir = config_dir.trim();
    if !dir.is_empty() {
        vars.retain(|(key, _)| key != "CLAUDE_CONFIG_DIR");
        vars.push(("CLAUDE_CONFIG_DIR".into(), dir.into()));
    }
    *OVERRIDES.write().unwrap_or_else(|e| e.into_inner()) = Overrides {
        env: vars,
        args: split_args(launch_args),
    };
}

/// `cli::command(exe)` with the user's environment variables set.
pub(crate) fn command(exe: &Path) -> Command {
    let mut cmd = cli::command(exe);
    cmd.envs(get().env);
    cmd
}

/// The user's extra launch arguments for a chat run.
pub(crate) fn launch_args() -> Vec<String> {
    get().args
}

/// `name` as the CLI sees it: the user's value, else the app's own environment.
pub(crate) fn env_var(name: &str) -> Option<OsString> {
    get()
        .env
        .into_iter()
        .rev()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.into())
        .or_else(|| std::env::var_os(name))
        .filter(|v| !v.is_empty())
}

/// The folder the CLI keeps its settings and login in.
pub(crate) fn config_dir() -> Option<PathBuf> {
    env_var("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .or_else(|| Some(cli::home_dir()?.join(".claude")))
}

/// `KEY=value` lines; malformed ones are skipped.
fn parse_env(text: &str) -> Vec<(String, String)> {
    text.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .filter_map(|line| {
            let (key, value) = line.split_once('=')?;
            let key = key.trim().trim_start_matches("export ").trim();
            let valid = !key.is_empty() && key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
            valid.then(|| (key.to_owned(), unquote(value.trim()).to_owned()))
        })
        .collect()
}

fn unquote(value: &str) -> &str {
    for quote in ['"', '\''] {
        if value.len() >= 2 && value.starts_with(quote) && value.ends_with(quote) {
            return &value[1..value.len() - 1];
        }
    }
    value
}

/// Splits like a shell: whitespace separates and quotes group. A backslash
/// escapes only whitespace or a quote outside quotes, so Windows paths stay as typed.
fn split_args(text: &str) -> Vec<String> {
    let mut args = Vec::new();
    let mut current = String::new();
    let mut started = false;
    let mut quote: Option<char> = None;
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match (quote, c) {
            (Some(q), c) if c == q => quote = None,
            (Some('\''), c) => current.push(c),
            (None, '\\') if chars.peek().is_some_and(|n| n.is_whitespace() || matches!(n, '"' | '\'')) => {
                current.extend(chars.next());
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
    fn env_lines_parse_and_skip_junk() {
        let env = parse_env("# comment\nFOO=bar\n export BAZ = \"a b\" \nnot a var\n1-X=y\nEMPTY=\n");
        assert_eq!(
            env,
            [("FOO".into(), "bar".into()), ("BAZ".into(), "a b".into()), ("EMPTY".into(), String::new())]
        );
    }

    #[test]
    fn args_split_like_a_shell() {
        assert_eq!(
            split_args(r#"--add-dir "C:\My Code" --flag 'it''s' a\ b """#),
            ["--add-dir", "C:\\My Code", "--flag", "its", "a b", ""]
        );
        assert!(split_args("   ").is_empty());
    }
}
