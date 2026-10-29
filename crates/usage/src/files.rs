//! JSONL history files (Claude's and Codex's transcripts): walked, read in
//! parallel, and cached per file. A file that only grew is read on from
//! where the last read stopped, once the 64 bytes before that point still
//! hash the same; anything else is read again from the start.

use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use crate::record::{fnv, Records};

/// How a harness's lines turn into records. The state carries what earlier
/// lines said (model, session) and is cached with the file to resume it.
pub trait Format: Default + Clone + Serialize + DeserializeOwned + Send {
    /// A line has to contain one of these to be parsed at all.
    const MARKERS: &'static [&'static str];
    fn parse(&mut self, line: &str, out: &mut Records);
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct FileEntry<S> {
    pub size: u64,
    pub mtime: i64,
    /// Bytes read so far (always the end of a whole line).
    pub offset: u64,
    /// `fnv` of the 64 bytes before `offset`.
    pub anchor: u64,
    pub state: S,
    pub records: Records,
}

impl<S> FileEntry<S> {
    pub fn newest(&self) -> i64 {
        self.records.records.iter().map(|r| r.at).max().unwrap_or(self.mtime)
    }
}

#[derive(Debug, Default)]
pub struct ScanStats {
    /// A root existed.
    pub found: bool,
    /// Files in range (read now or reused).
    pub files: u32,
    pub failed: u32,
    pub error: Option<String>,
    /// Something was read, so the cache should be saved.
    pub changed: bool,
}

struct Meta {
    path: PathBuf,
    size: u64,
    mtime: i64,
}

const ANCHOR: usize = 64;

/// Brings `cache` up to date with every `*.jsonl` under `roots` changed
/// since `skip_before` (Unix ms; older files are left out unless cached).
/// Entries of files that are gone stay: their usage still happened.
pub fn scan<S: Format>(
    roots: &[PathBuf],
    cache: &mut HashMap<String, FileEntry<S>>,
    skip_before: i64,
) -> ScanStats {
    let mut stats = ScanStats::default();
    let mut metas = Vec::new();
    for root in roots {
        if root.is_dir() {
            stats.found = true;
            walk(root, &mut metas);
        }
    }

    let mut todo = Vec::new();
    for meta in metas {
        let key = meta.path.to_string_lossy().into_owned();
        match cache.get(&key) {
            Some(e) if e.size == meta.size && e.mtime == meta.mtime => stats.files += 1,
            Some(_) => todo.push((key, meta)),
            None if meta.mtime >= skip_before => todo.push((key, meta)),
            None => {}
        }
    }
    if todo.is_empty() {
        return stats;
    }
    stats.changed = true;

    let jobs: Vec<(String, Meta, Option<FileEntry<S>>)> = todo
        .into_iter()
        .map(|(key, meta)| {
            let prev = cache.remove(&key);
            (key, meta, prev)
        })
        .collect();
    let next = AtomicUsize::new(0);
    let jobs: Vec<Mutex<Option<(String, Meta, Option<FileEntry<S>>)>>> =
        jobs.into_iter().map(|j| Mutex::new(Some(j))).collect();
    let done = Mutex::new(Vec::with_capacity(jobs.len()));
    let threads = std::thread::available_parallelism().map_or(4, |n| n.get()).clamp(1, 8);
    std::thread::scope(|scope| {
        for _ in 0..threads.min(jobs.len()) {
            scope.spawn(|| loop {
                let i = next.fetch_add(1, Ordering::Relaxed);
                let Some(slot) = jobs.get(i) else { break };
                let Some((key, meta, prev)) = slot.lock().unwrap().take() else { continue };
                let result = read(&meta, prev.clone());
                done.lock().unwrap().push((key, prev, result));
            });
        }
    });

    for (key, prev, result) in done.into_inner().unwrap() {
        match result {
            Ok(entry) => {
                stats.files += 1;
                cache.insert(key, entry);
            }
            Err(e) => {
                stats.failed += 1;
                stats.error.get_or_insert_with(|| format!("{key}: {e}"));
                if let Some(prev) = prev {
                    cache.insert(key, prev);
                }
            }
        }
    }
    stats
}

fn walk(dir: &Path, out: &mut Vec<Meta>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let Ok(kind) = entry.file_type() else { continue };
        let path = entry.path();
        if kind.is_dir() {
            walk(&path, out);
        } else if kind.is_file() && path.extension().is_some_and(|e| e == "jsonl") {
            let Ok(meta) = entry.metadata() else { continue };
            let mtime = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map_or(0, |d| d.as_millis() as i64);
            out.push(Meta { path, size: meta.len(), mtime });
        }
    }
}

fn read<S: Format>(meta: &Meta, prev: Option<FileEntry<S>>) -> std::io::Result<FileEntry<S>> {
    let mut file = File::open(&meta.path)?;
    let mut entry = match prev {
        Some(prev) if prev.offset <= meta.size && anchored(&mut file, &prev)? => prev,
        _ => FileEntry::default(),
    };
    entry.size = meta.size;
    entry.mtime = meta.mtime;
    if entry.offset == meta.size {
        return Ok(entry);
    }

    file.seek(SeekFrom::Start(entry.offset))?;
    let mut reader = BufReader::with_capacity(256 * 1024, file);
    let mut line = Vec::new();
    let mut tail: Vec<u8> = Vec::with_capacity(ANCHOR * 2);
    loop {
        line.clear();
        let n = reader.read_until(b'\n', &mut line)?;
        // A line still being written waits for the next read.
        if n == 0 || line.last() != Some(&b'\n') {
            break;
        }
        entry.offset += n as u64;
        if line.len() >= ANCHOR {
            tail.clear();
            tail.extend_from_slice(&line[line.len() - ANCHOR..]);
        } else {
            tail.extend_from_slice(&line);
            if tail.len() > ANCHOR {
                tail.drain(..tail.len() - ANCHOR);
            }
        }
        let Ok(text) = std::str::from_utf8(&line) else { continue };
        if S::MARKERS.iter().any(|m| text.contains(m)) {
            entry.state.parse(text, &mut entry.records);
        }
    }
    if (tail.len() as u64) < entry.offset.min(ANCHOR as u64) {
        // Resumed with fewer than 64 new bytes: take the anchor from disk.
        let mut file = File::open(&meta.path)?;
        entry.anchor = hash_before(&mut file, entry.offset)?;
    } else {
        entry.anchor = fnv(&tail);
    }
    Ok(entry)
}

fn anchored<S>(file: &mut File, prev: &FileEntry<S>) -> std::io::Result<bool> {
    if prev.offset == 0 {
        return Ok(false);
    }
    Ok(hash_before(file, prev.offset)? == prev.anchor)
}

fn hash_before(file: &mut File, offset: u64) -> std::io::Result<u64> {
    let start = offset.saturating_sub(ANCHOR as u64);
    file.seek(SeekFrom::Start(start))?;
    let mut buf = vec![0; (offset - start) as usize];
    file.read_exact(&mut buf)?;
    Ok(fnv(&buf))
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use super::*;
    use crate::record::{Record, NONE};

    /// Counts lines with "n", one record per line, `n` as its output.
    #[derive(Default, Clone, Serialize, Deserialize)]
    struct Lines {
        seen: u32,
    }

    impl Format for Lines {
        const MARKERS: &'static [&'static str] = &["\"n\""];
        fn parse(&mut self, line: &str, out: &mut Records) {
            self.seen += 1;
            let v: serde_json::Value = serde_json::from_str(line).unwrap();
            let model = out.intern("m");
            out.push(Record {
                at: 0,
                model,
                session: NONE,
                project: NONE,
                counts: [0, 0, 0, v["n"].as_u64().unwrap(), 0, 0],
                cost: None,
                fast: false,
                key: 0,
            });
        }
    }

    fn outputs(cache: &HashMap<String, FileEntry<Lines>>) -> Vec<u64> {
        let mut v: Vec<u64> =
            cache.values().flat_map(|e| e.records.records.iter().map(|r| r.counts[3])).collect();
        v.sort();
        v
    }

    #[test]
    fn resumes_appended_files_and_rereads_rewritten_ones() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a").join("s.jsonl");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let long = "x".repeat(100);
        fs::write(&path, format!("{{\"n\":1,\"pad\":\"{long}\"}}\n{{\"other\":1}}\n{{\"n\":2")).unwrap();
        let mut cache = HashMap::new();
        let roots = vec![dir.path().to_path_buf()];

        scan::<Lines>(&roots, &mut cache, 0);
        assert_eq!(outputs(&cache), vec![1]);

        // The unfinished line completes, another follows.
        let mut f = fs::OpenOptions::new().append(true).open(&path).unwrap();
        f.write_all(b"}\n{\"n\":3}\n").unwrap();
        drop(f);
        scan::<Lines>(&roots, &mut cache, 0);
        assert_eq!(outputs(&cache), vec![1, 2, 3]);
        assert_eq!(cache.values().next().unwrap().state.seen, 3);

        // Rewritten just before the offset, then grown: from scratch.
        let text = fs::read_to_string(&path).unwrap().replace("\"n\":3", "\"n\":9");
        fs::write(&path, text + "{\"n\":4}\n").unwrap();
        scan::<Lines>(&roots, &mut cache, 0);
        assert_eq!(outputs(&cache), vec![1, 2, 4, 9]);
        assert_eq!(cache.values().next().unwrap().state.seen, 4);

        // Deleted: what it recorded stays.
        fs::remove_file(&path).unwrap();
        scan::<Lines>(&roots, &mut cache, 0);
        assert_eq!(outputs(&cache), vec![1, 2, 4, 9]);
    }
}
