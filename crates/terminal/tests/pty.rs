//! Real shells in real ptys (unix: `/bin/sh` is always there).
#![cfg(unix)]

use std::sync::mpsc;
use std::time::{Duration, Instant};

use outcode_terminal::{Shell, Sink, Terminals};

enum Event {
    Data(Vec<u8>),
    Process(Option<String>),
    Exit(Option<u32>),
}

struct Events(mpsc::Sender<Event>);

impl Sink for Events {
    fn data(&self, bytes: Vec<u8>) -> bool {
        self.0.send(Event::Data(bytes)).is_ok()
    }
    fn process(&self, name: Option<String>) -> bool {
        self.0.send(Event::Process(name)).is_ok()
    }
    fn exit(&self, code: Option<u32>) {
        let _ = self.0.send(Event::Exit(code));
    }
}

fn sh(args: &[&str]) -> Shell {
    Shell {
        program: "/bin/sh".into(),
        args: Some(args.iter().map(|s| s.to_string()).collect()),
        ..Shell::default()
    }
}

/// Output so far and the exit code, once `/bin/sh` has gone (or `timeout`).
fn run_to_exit(events: &mpsc::Receiver<Event>, timeout: Duration) -> (String, Option<Option<u32>>) {
    let mut out = Vec::new();
    let deadline = Instant::now() + timeout;
    while let Ok(event) = events.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
        match event {
            Event::Data(bytes) => out.extend(bytes),
            Event::Process(_) => {}
            Event::Exit(code) => return (String::from_utf8_lossy(&out).into_owned(), Some(code)),
        }
    }
    (String::from_utf8_lossy(&out).into_owned(), None)
}

#[test]
fn output_and_exit_code() {
    let terminals = Terminals::default();
    let (tx, rx) = mpsc::channel();
    let started = terminals
        .spawn("test", &sh(&["-c", "printf 'hello'; exit 3"]), 80, 24, Events(tx))
        .unwrap();
    assert_eq!(started.shell, "sh");
    let (out, code) = run_to_exit(&rx, Duration::from_secs(10));
    assert!(out.contains("hello"), "{out:?}");
    assert_eq!(code, Some(Some(3)));
    assert!(!terminals.any());
}

#[test]
fn input_reaches_the_shell() {
    let terminals = Terminals::default();
    let (tx, rx) = mpsc::channel();
    let started = terminals.spawn("test", &sh(&[]), 80, 24, Events(tx)).unwrap();
    terminals.write(started.id, b"echo $((6*7)); exit\n".to_vec());
    let (out, code) = run_to_exit(&rx, Duration::from_secs(10));
    assert!(out.contains("42"), "{out:?}");
    assert_eq!(code, Some(Some(0)));
}

#[test]
fn env_and_cwd_apply() {
    let terminals = Terminals::default();
    let (tx, rx) = mpsc::channel();
    let dir = std::env::temp_dir().canonicalize().unwrap();
    let shell = Shell {
        env: vec![("OUTCODE_TEST".into(), "it-works".into())],
        cwd: Some(dir.clone()),
        term_program: Some(("Outcode".into(), "1.2.3".into())),
        ..sh(&["-c", "echo \"$OUTCODE_TEST $TERM $TERM_PROGRAM\"; pwd -P"])
    };
    terminals.spawn("test", &shell, 80, 24, Events(tx)).unwrap();
    let (out, _) = run_to_exit(&rx, Duration::from_secs(10));
    assert!(out.contains("it-works xterm-256color Outcode"), "{out:?}");
    assert!(out.contains(&*dir.to_string_lossy()), "{out:?}");
}

#[test]
fn foreground_program_is_reported() {
    let terminals = Terminals::default();
    let (tx, rx) = mpsc::channel();
    let started = terminals.spawn("test", &sh(&[]), 80, 24, Events(tx)).unwrap();
    terminals.write(started.id, b"sleep 30\n".to_vec());
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut seen = None;
    while let Ok(event) = rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
        if let Event::Process(Some(name)) = event {
            seen = Some(name);
            break;
        }
    }
    assert_eq!(seen.as_deref(), Some("sleep"));
    assert_eq!(terminals.foreground(started.id).as_deref(), Some("sleep"));

    // A hangup ends the shell and what runs in it.
    terminals.kill_owned_by("test");
    let (_, code) = run_to_exit(&rx, Duration::from_secs(10));
    assert!(code.is_some(), "no exit after hangup");
    assert!(!terminals.any());
}
