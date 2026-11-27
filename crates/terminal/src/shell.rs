//! Which shell a terminal starts, and how.

use std::path::{Path, PathBuf};

use portable_pty::CommandBuilder;

/// Variables a terminal the app was started from would leak into ours.
const FOREIGN_ENV: &[&str] = &[
    "TERM_SESSION_ID",
    "ITERM_SESSION_ID",
    "ITERM_PROFILE",
    "LC_TERMINAL",
    "LC_TERMINAL_VERSION",
    "KITTY_WINDOW_ID",
    "ALACRITTY_WINDOW_ID",
    "WEZTERM_PANE",
    "WT_SESSION",
    "VSCODE_INJECTION",
];

/// A shell to start in a terminal.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Shell {
    /// The executable (a leading `~` is the home folder). Empty: the user's
    /// login shell (`$SHELL`), or PowerShell on Windows.
    pub program: String,
    /// Its arguments. `None`: the platform's usual ones (a login shell on
    /// macOS, as Terminal.app starts it; no logo for PowerShell).
    pub args: Option<Vec<String>>,
    /// Set on top of the app's own environment.
    pub env: Vec<(String, String)>,
    /// The folder it starts in; the home folder when missing or gone.
    pub cwd: Option<PathBuf>,
    /// `TERM_PROGRAM` and `TERM_PROGRAM_VERSION`.
    pub term_program: Option<(String, String)>,
}

impl Shell {
    pub(crate) fn command(&self) -> CommandBuilder {
        let program = match self.program.trim() {
            "" => default_program(),
            given => expand_home(given),
        };
        let args = self.args.clone().unwrap_or_else(|| default_args(&program));
        let mut cmd = CommandBuilder::new(&program);
        cmd.args(args);

        let cwd = self
            .cwd
            .clone()
            .filter(|dir| dir.is_dir())
            .or_else(home_dir);
        if let Some(dir) = cwd {
            cmd.cwd(dir);
        }

        for name in FOREIGN_ENV {
            cmd.env_remove(name);
        }
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        match &self.term_program {
            Some((name, version)) => {
                cmd.env("TERM_PROGRAM", name);
                cmd.env("TERM_PROGRAM_VERSION", version);
            }
            None => {
                cmd.env_remove("TERM_PROGRAM");
                cmd.env_remove("TERM_PROGRAM_VERSION");
            }
        }
        // An app opened from the Finder gets no locale, and shells then
        // mangle anything past ASCII.
        #[cfg(unix)]
        if ["LANG", "LC_ALL", "LC_CTYPE"].iter().all(|v| cmd.get_env(v).is_none()) {
            cmd.env("LANG", "en_US.UTF-8");
        }
        for (key, value) in &self.env {
            cmd.env(key, value);
        }
        cmd
    }
}

/// The shell's name as a tab shows it (`zsh`, `pwsh`).
pub(crate) fn display_name(cmd: &CommandBuilder) -> String {
    let program = cmd
        .get_argv()
        .first()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    Path::new(&program)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or(program)
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
}

fn expand_home(path: &str) -> String {
    match (path.strip_prefix('~'), home_dir()) {
        (Some(rest), Some(home)) if rest.is_empty() || rest.starts_with(['/', '\\']) => {
            format!("{}{rest}", home.display())
        }
        _ => path.to_owned(),
    }
}

#[cfg(windows)]
fn default_program() -> String {
    std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
        .map(|dir| dir.join("pwsh.exe"))
        .find(|path| path.is_file())
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_else(|| "powershell.exe".into())
}

/// `$SHELL`, else the account's shell, else the platform's.
#[cfg(unix)]
fn default_program() -> String {
    std::env::var("SHELL")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .or_else(account_shell)
        .unwrap_or_else(|| if cfg!(target_os = "macos") { "/bin/zsh" } else { "/bin/bash" }.into())
}

/// The shell the user database gives the current user.
#[cfg(unix)]
fn account_shell() -> Option<String> {
    // SAFETY: getpwuid's result is read at once, before anything else could
    // call it again on this thread.
    unsafe {
        let entry = libc::getpwuid(libc::getuid());
        if entry.is_null() || (*entry).pw_shell.is_null() {
            return None;
        }
        let shell = std::ffi::CStr::from_ptr((*entry).pw_shell).to_string_lossy().into_owned();
        (!shell.is_empty()).then_some(shell)
    }
}

fn default_args(program: &str) -> Vec<String> {
    let name = Path::new(program)
        .file_stem()
        .map(|s| s.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    if name == "pwsh" || name == "powershell" {
        // `-Login` only counts as the first argument.
        let mut args = Vec::new();
        if cfg!(target_os = "macos") {
            args.push("-Login".to_owned());
        }
        args.push("-NoLogo".into());
        return args;
    }
    // cmd and nu take no `-l`-style flag the same way; leave them be.
    if cfg!(target_os = "macos") && !matches!(name.as_str(), "cmd" | "nu") {
        return vec!["-l".into()];
    }
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_args_per_shell() {
        let login = if cfg!(target_os = "macos") { vec!["-l".to_owned()] } else { vec![] };
        assert_eq!(default_args("/bin/zsh"), login);
        assert_eq!(default_args("/opt/homebrew/bin/fish"), login);
        assert_eq!(default_args("nu"), Vec::<String>::new());
        assert!(default_args("pwsh.exe").contains(&"-NoLogo".to_owned()));
    }

    #[test]
    fn home_is_expanded() {
        let Some(home) = home_dir() else { return };
        assert_eq!(expand_home("~/bin/zsh"), format!("{}/bin/zsh", home.display()));
        assert_eq!(expand_home("~"), home.display().to_string());
        assert_eq!(expand_home("~other/zsh"), "~other/zsh");
        assert_eq!(expand_home("/bin/zsh"), "/bin/zsh");
    }
}
