//! What runs in front of a shell, for its tab's title.

use std::collections::HashMap;

use sysinfo::{Pid, Process, ProcessRefreshKind, ProcessesToUpdate, System};

/// Shells, looked through for the program they run (`bash` started from
/// `zsh`, npm's `sh -c`).
const SHELLS: &[&str] = &[
    "pwsh", "powershell", "cmd", "bash", "zsh", "sh", "fish", "nu", "dash", "ksh", "tcsh", "csh", "elvish", "xonsh",
];

/// Console hosts that can sit under a shell on Windows.
const HOSTS: &[&str] = &["conhost", "openconsole"];

/// A process's name, without `.exe`, and without the `-` a login shell's
/// name starts with.
fn name_of(process: &Process) -> String {
    let name = process.name().to_string_lossy();
    let name = name.strip_prefix('-').unwrap_or(&name);
    match name.len().checked_sub(4) {
        Some(at) if cfg!(windows) && name[at..].eq_ignore_ascii_case(".exe") => name[..at].to_owned(),
        _ => name.to_owned(),
    }
}

fn is_shell(name: &str) -> bool {
    SHELLS.contains(&name.to_ascii_lowercase().as_str())
}

/// What runs in the shell `shell`: `None` while the shell itself is in
/// front, else the program's name (`cargo`, `node`, `vim`). With the pty's
/// foreground process group (`leader`, unix), its leader; else the newest
/// child, followed down through shells (as VS Code does on Windows).
pub fn find(system: &mut System, shell: u32, leader: Option<u32>) -> Option<String> {
    if let Some(leader) = leader {
        if leader == shell {
            return None;
        }
        let pid = Pid::from_u32(leader);
        system.refresh_processes_specifics(ProcessesToUpdate::Some(&[pid]), true, ProcessRefreshKind::nothing());
        if let Some(process) = system.process(pid) {
            return Some(name_of(process));
        }
    }

    system.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing());
    let mut children: HashMap<Pid, Vec<&Process>> = HashMap::new();
    for process in system.processes().values() {
        if let Some(parent) = process.parent() {
            children.entry(parent).or_default().push(process);
        }
    }
    let shell = Pid::from_u32(shell);
    let mut current = system.process(shell)?;
    // Bounded, in case reused ids make a loop.
    for _ in 0..16 {
        let newest = children
            .get(&current.pid())
            .into_iter()
            .flatten()
            .filter(|p| !HOSTS.contains(&name_of(p).to_ascii_lowercase().as_str()))
            .max_by_key(|p| (p.start_time(), p.pid()));
        let Some(&child) = newest else {
            // A shell started from the shell, at its prompt.
            return (current.pid() != shell).then(|| name_of(current));
        };
        current = child;
        let name = name_of(child);
        if !is_shell(&name) {
            return Some(name);
        }
    }
    Some(name_of(current))
}
