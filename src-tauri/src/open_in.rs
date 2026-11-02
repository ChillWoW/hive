//! "Open in …": the code editors installed here, and opening a folder in one
//! (the chat details card). The frontend (`src/editors`) has each id's label
//! and mark.

use std::path::{Path, PathBuf};
use std::process::Command;

use crate::util::{blocking, err};

struct Editor {
    id: &'static str,
    /// CLI names, looked up on PATH.
    commands: &'static [&'static str],
    /// Where Windows installers put its CLI or exe, under `%LOCALAPPDATA%`
    /// or `%ProgramFiles%` (tried both).
    windows: &'static [&'static str],
    /// macOS app bundles, in `/Applications` or `~/Applications`, opened
    /// with `open -a` (an app started from Finder doesn't see the shell's
    /// PATH, where the CLIs are).
    mac: &'static [&'static str],
    /// A JetBrains IDE: also the Toolbox's shell scripts.
    toolbox: bool,
}

const fn editor(id: &'static str, commands: &'static [&'static str]) -> Editor {
    Editor {
        id,
        commands,
        windows: &[],
        mac: &[],
        toolbox: false,
    }
}

const fn jetbrains(id: &'static str, command: &'static [&'static str], mac: &'static [&'static str]) -> Editor {
    Editor {
        mac,
        toolbox: true,
        ..editor(id, command)
    }
}

/// In the order the menu lists them; the first one installed is the default.
const EDITORS: &[Editor] = &[
    Editor {
        windows: &[
            r"Programs\Microsoft VS Code\bin\code.cmd",
            r"Microsoft VS Code\bin\code.cmd",
        ],
        mac: &["Visual Studio Code.app"],
        ..editor("vscode", &["code"])
    },
    Editor {
        windows: &[r"Programs\cursor\resources\app\bin\cursor.cmd"],
        mac: &["Cursor.app"],
        ..editor("cursor", &["cursor"])
    },
    Editor {
        windows: &[
            r"Programs\Zed\bin\zed.exe",
            r"Programs\Zed\Zed.exe",
            r"Programs\Zed Preview\bin\zed.exe",
        ],
        mac: &["Zed.app"],
        ..editor("zed", &["zed", "zeditor"])
    },
    Editor {
        windows: &[r"Programs\Windsurf\bin\windsurf.cmd"],
        mac: &["Windsurf.app"],
        ..editor("windsurf", &["windsurf"])
    },
    Editor {
        windows: &[
            r"Programs\Microsoft VS Code Insiders\bin\code-insiders.cmd",
            r"Microsoft VS Code Insiders\bin\code-insiders.cmd",
        ],
        mac: &["Visual Studio Code - Insiders.app"],
        ..editor("vscode-insiders", &["code-insiders"])
    },
    Editor {
        windows: &[r"Programs\VSCodium\bin\codium.cmd", r"VSCodium\bin\codium.cmd"],
        mac: &["VSCodium.app"],
        ..editor("vscodium", &["codium"])
    },
    Editor {
        windows: &[r"Programs\Trae\bin\trae.cmd"],
        mac: &["Trae.app"],
        ..editor("trae", &["trae"])
    },
    Editor {
        windows: &[r"Programs\Kiro\bin\kiro.cmd"],
        mac: &["Kiro.app"],
        ..editor("kiro", &["kiro"])
    },
    Editor {
        mac: &["Antigravity.app"],
        ..editor("antigravity", &["antigravity-ide", "agy-ide"])
    },
    jetbrains("idea", &["idea"], &["IntelliJ IDEA.app", "IntelliJ IDEA CE.app", "IntelliJ IDEA Ultimate.app"]),
    jetbrains("webstorm", &["webstorm"], &["WebStorm.app"]),
    jetbrains("rustrover", &["rustrover"], &["RustRover.app"]),
    jetbrains("pycharm", &["pycharm"], &["PyCharm.app", "PyCharm CE.app", "PyCharm Professional Edition.app"]),
    jetbrains("goland", &["goland"], &["GoLand.app"]),
    jetbrains("clion", &["clion"], &["CLion.app"]),
    jetbrains("rider", &["rider"], &["Rider.app"]),
    jetbrains("phpstorm", &["phpstorm"], &["PhpStorm.app"]),
    jetbrains("rubymine", &["rubymine"], &["RubyMine.app"]),
    jetbrains("datagrip", &["datagrip"], &["DataGrip.app"]),
    jetbrains("dataspell", &["dataspell"], &["DataSpell.app"]),
    jetbrains("aqua", &["aqua"], &["Aqua.app"]),
];

enum Launch {
    /// A CLI or exe, given the folder.
    Exe(PathBuf),
    /// A macOS app bundle, through `open -a`.
    App(PathBuf),
}

fn home() -> Option<PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from)
}

fn on_path(name: &str) -> Option<PathBuf> {
    let exts: &[&str] = if cfg!(windows) { &["exe", "cmd", "bat"] } else { &[""] };
    std::env::split_paths(&std::env::var_os("PATH")?).find_map(|dir| {
        exts.iter().find_map(|ext| {
            let path = dir.join(name).with_extension(ext);
            path.is_file().then_some(path)
        })
    })
}

/// The JetBrains Toolbox's folder of launcher scripts.
fn toolbox_scripts() -> Option<PathBuf> {
    if cfg!(windows) {
        std::env::var_os("LOCALAPPDATA").map(|d| PathBuf::from(d).join(r"JetBrains\Toolbox\scripts"))
    } else if cfg!(target_os = "macos") {
        home().map(|h| h.join("Library/Application Support/JetBrains/Toolbox/scripts"))
    } else {
        home().map(|h| h.join(".local/share/JetBrains/Toolbox/scripts"))
    }
}

fn find(editor: &Editor) -> Option<Launch> {
    if cfg!(target_os = "macos") {
        let dirs = [Some(PathBuf::from("/Applications")), home().map(|h| h.join("Applications"))];
        for app in editor.mac {
            for dir in dirs.iter().flatten() {
                let path = dir.join(app);
                if path.is_dir() {
                    return Some(Launch::App(path));
                }
            }
        }
    }
    if let Some(path) = editor.commands.iter().find_map(|c| on_path(c)) {
        return Some(Launch::Exe(path));
    }
    if cfg!(windows) {
        let roots: Vec<PathBuf> = ["LOCALAPPDATA", "ProgramFiles"]
            .iter()
            .filter_map(|v| std::env::var_os(v).map(PathBuf::from))
            .collect();
        for relative in editor.windows {
            for root in &roots {
                let path = root.join(relative);
                if path.is_file() {
                    return Some(Launch::Exe(path));
                }
            }
        }
    }
    if editor.toolbox {
        let dir = toolbox_scripts()?;
        let ext = if cfg!(windows) { "cmd" } else { "" };
        return editor.commands.iter().find_map(|c| {
            let path = dir.join(c).with_extension(ext);
            path.is_file().then_some(Launch::Exe(path))
        });
    }
    None
}

fn launch(how: Launch, folder: &Path) -> Result<(), String> {
    let mut cmd = match how {
        Launch::App(app) => {
            let mut cmd = Command::new("open");
            cmd.arg("-a").arg(app);
            cmd
        }
        Launch::Exe(exe) => {
            // `std` quotes arguments for a `.cmd` itself.
            let mut cmd = Command::new(exe);
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                // The `.cmd` shims' console stays hidden; the editor's window doesn't.
                cmd.creation_flags(0x0800_0000);
            }
            cmd
        }
    };
    cmd.arg(folder).current_dir(folder);
    // Not waited for: the editor outlives the launch.
    cmd.spawn().map(drop).map_err(err)
}

/// The ids of the editors installed here, in menu order.
#[tauri::command]
pub async fn list_editors() -> Result<Vec<String>, String> {
    blocking(|| {
        Ok(EDITORS
            .iter()
            .filter(|e| find(e).is_some())
            .map(|e| e.id.to_string())
            .collect())
    })
    .await
}

/// Opens `path` (a folder) in the editor `id`.
#[tauri::command]
pub async fn open_in_editor(id: String, path: String) -> Result<(), String> {
    blocking(move || {
        let editor = EDITORS.iter().find(|e| e.id == id).ok_or("Unknown editor")?;
        let folder = PathBuf::from(&path);
        if !folder.is_dir() {
            return Err(format!("{path} isn't a folder"));
        }
        let how = find(editor).ok_or("That editor isn't installed")?;
        launch(how, &folder)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_unique() {
        let mut ids: Vec<_> = EDITORS.iter().map(|e| e.id).collect();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), EDITORS.len());
    }
}
