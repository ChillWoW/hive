//! Per-chat run journals: `journals/{chatId}.jsonl`, one line per event,
//! appended as it arrives.
//!
//! The journal is the full-fidelity record of every run and the crash gauge:
//! a message whose lines never reach a top-level `Done` belongs to a run
//! that died mid-stream. Each line names the assistant message it folded
//! into, so that message can be rebuilt from the journal alone. A torn last
//! line from a crash mid-write is skipped on read.

use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};

use hive_proto::AgentEvent;
use serde::{Deserialize, Serialize};

use crate::StoreError;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalLine {
    /// Monotonic per chat, from 0.
    pub seq: u64,
    /// Epoch millis.
    pub at: i64,
    pub message_id: String,
    pub event: AgentEvent,
}

struct OpenJournal {
    file: File,
    next_seq: u64,
    /// The file ends mid-line (a torn write); the next append starts a new
    /// line so the torn one stays isolated.
    needs_newline: bool,
}

pub struct Journal {
    dir: PathBuf,
    open: Mutex<HashMap<String, OpenJournal>>,
}

impl Journal {
    pub fn open(dir: impl Into<PathBuf>) -> Result<Self, StoreError> {
        let dir = dir.into();
        std::fs::create_dir_all(&dir)?;
        Ok(Self {
            dir,
            open: Mutex::new(HashMap::new()),
        })
    }

    pub fn path(&self, chat_id: &str) -> PathBuf {
        self.dir.join(format!("{}.jsonl", file_stem(chat_id)))
    }

    /// Appends `event` and returns its seq.
    pub fn append(
        &self,
        chat_id: &str,
        message_id: &str,
        at: i64,
        event: &AgentEvent,
    ) -> Result<u64, StoreError> {
        let mut open = self.open.lock().unwrap_or_else(PoisonError::into_inner);
        let journal = match open.entry(chat_id.to_owned()) {
            std::collections::hash_map::Entry::Occupied(e) => e.into_mut(),
            std::collections::hash_map::Entry::Vacant(e) => e.insert(self.open_file(chat_id)?),
        };
        let line = JournalLine {
            seq: journal.next_seq,
            at,
            message_id: message_id.to_owned(),
            event: event.clone(),
        };
        let mut bytes = Vec::new();
        if journal.needs_newline {
            bytes.push(b'\n');
        }
        serde_json::to_writer(&mut bytes, &line)?;
        bytes.push(b'\n');
        journal.file.write_all(&bytes)?;
        journal.needs_newline = false;
        journal.next_seq += 1;
        Ok(line.seq)
    }

    fn open_file(&self, chat_id: &str) -> Result<OpenJournal, StoreError> {
        let path = self.path(chat_id);
        let mut file = OpenOptions::new()
            .create(true)
            .read(true)
            .append(true)
            .open(&path)?;
        let len = file.metadata()?.len();
        let needs_newline = len > 0 && {
            file.seek(SeekFrom::Start(len - 1))?;
            let mut last = [0u8];
            file.read_exact(&mut last)?;
            last[0] != b'\n'
        };
        let next_seq = read_lines(&path)?.last().map_or(0, |l| l.seq + 1);
        Ok(OpenJournal {
            file,
            next_seq,
            needs_newline,
        })
    }

    /// Every readable line, oldest first.
    pub fn read(&self, chat_id: &str) -> Result<Vec<JournalLine>, StoreError> {
        read_lines(&self.path(chat_id))
    }

    /// Chats that have a journal.
    pub fn chats(&self) -> Result<Vec<String>, StoreError> {
        let mut chats = Vec::new();
        for entry in std::fs::read_dir(&self.dir)? {
            let name = entry?.file_name();
            if let Some(stem) = name.to_str().and_then(|n| n.strip_suffix(".jsonl")) {
                chats.push(stem.to_owned());
            }
        }
        Ok(chats)
    }

    pub fn delete(&self, chat_id: &str) -> Result<(), StoreError> {
        self.open
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(chat_id);
        match std::fs::remove_file(self.path(chat_id)) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.into()),
            _ => Ok(()),
        }
    }
}

fn read_lines(path: &Path) -> Result<Vec<JournalLine>, StoreError> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e.into()),
    };
    let mut lines = Vec::new();
    for line in BufReader::new(file).lines() {
        // A torn or foreign line is skipped, not fatal.
        if let Ok(line) = serde_json::from_str::<JournalLine>(&line?) {
            lines.push(line);
        }
    }
    Ok(lines)
}

/// Chat ids are ours (UUIDs), but a file name never gets a path separator.
fn file_stem(chat_id: &str) -> String {
    chat_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(t: &str) -> AgentEvent {
        AgentEvent::TextDelta { text: t.into() }
    }

    #[test]
    fn appends_and_resumes_seq_across_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let journal = Journal::open(dir.path()).unwrap();
        assert_eq!(journal.append("c1", "m1", 1, &text("a")).unwrap(), 0);
        assert_eq!(journal.append("c1", "m1", 2, &text("b")).unwrap(), 1);
        drop(journal);

        let journal = Journal::open(dir.path()).unwrap();
        assert_eq!(journal.append("c1", "m2", 3, &text("c")).unwrap(), 2);
        let lines = journal.read("c1").unwrap();
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[2].message_id, "m2");
        assert_eq!(journal.chats().unwrap(), vec!["c1".to_owned()]);
    }

    #[test]
    fn a_torn_line_is_skipped_and_isolated() {
        let dir = tempfile::tempdir().unwrap();
        let journal = Journal::open(dir.path()).unwrap();
        journal.append("c1", "m1", 1, &text("a")).unwrap();
        drop(journal);
        let path = dir.path().join("c1.jsonl");
        let mut file = OpenOptions::new().append(true).open(&path).unwrap();
        file.write_all(br#"{"seq":1,"at":2,"mess"#).unwrap();
        drop(file);

        let journal = Journal::open(dir.path()).unwrap();
        assert_eq!(journal.read("c1").unwrap().len(), 1);
        assert_eq!(journal.append("c1", "m1", 3, &text("b")).unwrap(), 1);
        let lines = journal.read("c1").unwrap();
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[1].event, text("b"));
    }
}
