//! The file panel's text search: every line under a folder matching a query,
//! over the same files the panel lists (`.gitignore` minded unless `all`).
//! Binary files, links and files past `MAX_FILE_BYTES` are skipped; the
//! search stops at `MAX_MATCHES` lines. A newer search ends an older one.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use hive_proto::{TextMatch, TextSearchFile, TextSearchOptions, TextSearchResult};
use ignore::WalkState;
use regex::{Regex, RegexBuilder};

use crate::files::{check_root, relative, walker};
use crate::util::blocking;

/// Matching lines past this aren't looked for.
const MAX_MATCHES: usize = 5_000;
/// Bigger files are skipped (generated bundles, data, logs).
const MAX_FILE_BYTES: u64 = 4 * 1024 * 1024;
/// A NUL in this many first bytes means binary.
const BINARY_PROBE: usize = 8 * 1024;
/// A long line's preview: this many characters before its first match…
const CONTEXT_BEFORE: usize = 40;
/// …and this many in all.
const PREVIEW_CHARS: usize = 240;
/// A preview never grows past this many bytes for a long first match.
const MAX_PREVIEW_BYTES: usize = 2_000;

/// Each folder's running search, by its cancel flag.
static RUNNING: Mutex<Option<HashMap<PathBuf, Arc<AtomicBool>>>> = Mutex::new(None);

/// A new search of `root`; the one running there is cancelled.
fn begin(root: &Path) -> Arc<AtomicBool> {
    let cancel = Arc::new(AtomicBool::new(false));
    let previous = RUNNING
        .lock()
        .unwrap()
        .get_or_insert_with(HashMap::new)
        .insert(root.to_owned(), cancel.clone());
    if let Some(previous) = previous {
        previous.store(true, Ordering::Relaxed);
    }
    cancel
}

/// Forgets `root`'s search when it's still the running one.
fn end(root: &Path, cancel: &Arc<AtomicBool>) {
    if let Some(running) = RUNNING.lock().unwrap().as_mut() {
        if running.get(root).is_some_and(|c| Arc::ptr_eq(c, cancel)) {
            running.remove(root);
        }
    }
}

fn pattern(query: &str, options: &TextSearchOptions) -> Result<Regex, String> {
    let mut source = if options.regex {
        query.to_owned()
    } else {
        regex::escape(query)
    };
    if options.whole_word {
        source = format!(r"\b(?:{source})\b");
    }
    RegexBuilder::new(&source)
        .case_insensitive(!options.case_sensitive)
        .build()
        .map_err(|error| match error {
            regex::Error::Syntax(message) => format!("Invalid regular expression: {message}"),
            other => other.to_string(),
        })
}

fn utf16_len(text: &str) -> u32 {
    text.encode_utf16().count() as u32
}

/// The char boundary at or before `index`.
fn floor(text: &str, mut index: usize) -> usize {
    index = index.min(text.len());
    while !text.is_char_boundary(index) {
        index -= 1;
    }
    index
}

/// `line` (1-based `number`) as a result, when `re` matches in it.
fn line_match(line: &str, number: usize, re: &Regex) -> Option<TextMatch> {
    let found: Vec<(usize, usize)> = re
        .find_iter(line)
        .filter(|m| !m.is_empty())
        .map(|m| (m.start(), m.end()))
        .collect();
    let &(first, first_end) = found.first()?;

    // Leading whitespace isn't shown; a long line starts a little before its
    // first match.
    let indent = line.len() - line.trim_start().len();
    let back = line[..first]
        .char_indices()
        .rev()
        .nth(CONTEXT_BEFORE.saturating_sub(1))
        .map_or(0, |(i, _)| i);
    let start = back.max(indent.min(first));
    let end = line[start..]
        .char_indices()
        .nth(PREVIEW_CHARS)
        .map_or(line.len(), |(i, _)| start + i)
        .max(floor(line, first_end.min(start + MAX_PREVIEW_BYTES)));

    let ranges = found
        .iter()
        .filter(|&&(s, _)| s < end)
        .map(|&(s, e)| {
            let (s, e) = (s.max(start), e.min(end));
            (utf16_len(&line[start..s]), utf16_len(&line[start..e]))
        })
        .collect();
    Some(TextMatch {
        line: number as u32,
        preview: line[start..end].to_owned(),
        preview_offset: utf16_len(&line[..start]),
        ranges,
    })
}

/// `bytes`' matching lines, or None for a binary file or no match.
fn search_bytes(bytes: &[u8], re: &Regex, budget: usize) -> Option<Vec<TextMatch>> {
    if bytes[..bytes.len().min(BINARY_PROBE)].contains(&0) {
        return None;
    }
    let text = String::from_utf8_lossy(bytes);
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
    if !re.is_match(text) {
        return None;
    }
    let matches: Vec<_> = text
        .split('\n')
        .enumerate()
        .filter_map(|(i, line)| line_match(line.strip_suffix('\r').unwrap_or(line), i + 1, re))
        .take(budget)
        .collect();
    (!matches.is_empty()).then_some(matches)
}

fn search(
    root: &Path,
    query: &str,
    options: &TextSearchOptions,
    all: bool,
) -> Result<TextSearchResult, String> {
    check_root(root)?;
    let re = pattern(query, options)?;
    let cancel = begin(root);
    let result = walk(root, &re, all, &cancel);
    end(root, &cancel);
    result
}

fn walk(
    root: &Path,
    re: &Regex,
    all: bool,
    cancel: &AtomicBool,
) -> Result<TextSearchResult, String> {
    let files = Mutex::new(Vec::new());
    let count = AtomicUsize::new(0);
    let truncated = AtomicBool::new(false);
    walker(root, None, all).build_parallel().run(|| {
        Box::new(|entry| {
            if cancel.load(Ordering::Relaxed) {
                return WalkState::Quit;
            }
            let Ok(entry) = entry else {
                return WalkState::Continue;
            };
            if !entry.file_type().is_some_and(|kind| kind.is_file()) {
                return WalkState::Continue;
            }
            if entry
                .metadata()
                .map_or(true, |meta| meta.len() > MAX_FILE_BYTES)
            {
                return WalkState::Continue;
            }
            let Some(path) = relative(root, entry.path()) else {
                return WalkState::Continue;
            };
            let Ok(bytes) = std::fs::read(entry.path()) else {
                return WalkState::Continue;
            };
            let budget = MAX_MATCHES.saturating_sub(count.load(Ordering::Relaxed));
            if budget == 0 {
                truncated.store(true, Ordering::Relaxed);
                return WalkState::Quit;
            }
            if let Some(matches) = search_bytes(&bytes, re, budget) {
                let total = count.fetch_add(matches.len(), Ordering::Relaxed) + matches.len();
                files.lock().unwrap().push(TextSearchFile { path, matches });
                if total >= MAX_MATCHES {
                    truncated.store(true, Ordering::Relaxed);
                    return WalkState::Quit;
                }
            }
            WalkState::Continue
        })
    });

    if cancel.load(Ordering::Relaxed) {
        return Err("Search cancelled".into());
    }
    let mut files = files.into_inner().unwrap();
    files.sort_by_cached_key(|file| file.path.to_lowercase());
    Ok(TextSearchResult {
        files,
        truncated: truncated.into_inner(),
    })
}

#[tauri::command]
pub async fn search_text(
    cwd: String,
    query: String,
    options: TextSearchOptions,
    all: bool,
) -> Result<TextSearchResult, String> {
    blocking(move || search(Path::new(&cwd), &query, &options, all)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn options(case_sensitive: bool, whole_word: bool, regex: bool) -> TextSearchOptions {
        TextSearchOptions {
            case_sensitive,
            whole_word,
            regex,
        }
    }

    fn project() -> tempfile::TempDir {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::create_dir_all(root.join("target")).unwrap();
        std::fs::write(root.join(".gitignore"), "target/\n").unwrap();
        std::fs::write(root.join("README.md"), "Hello world\r\nhello again\n").unwrap();
        std::fs::write(
            root.join("src/main.rs"),
            "fn main() {\n    let helloWorld = 1;\n}\n",
        )
        .unwrap();
        std::fs::write(root.join("src/data.bin"), b"hello\0world").unwrap();
        std::fs::write(root.join("target/out.txt"), "hello").unwrap();
        temp
    }

    fn lines(result: &TextSearchResult) -> Vec<String> {
        result
            .files
            .iter()
            .flat_map(|f| {
                f.matches
                    .iter()
                    .map(move |m| format!("{}:{}:{}", f.path, m.line, m.preview))
            })
            .collect()
    }

    #[test]
    fn finds_lines_in_listed_text_files() {
        let temp = project();
        let found = search(temp.path(), "hello", &options(false, false, false), false).unwrap();
        assert_eq!(
            lines(&found),
            [
                "README.md:1:Hello world",
                "README.md:2:hello again",
                "src/main.rs:2:let helloWorld = 1;"
            ]
        );
        assert_eq!(found.files[1].matches[0].preview_offset, 4);
        assert_eq!(found.files[1].matches[0].ranges, [(4, 9)]);
        assert!(!found.truncated);

        let all = search(temp.path(), "hello", &options(false, false, false), true).unwrap();
        assert!(all.files.iter().any(|f| f.path == "target/out.txt"));
    }

    #[test]
    fn minds_the_options() {
        let temp = project();
        let root = temp.path();
        let case = search(root, "Hello", &options(true, false, false), false).unwrap();
        assert_eq!(lines(&case), ["README.md:1:Hello world"]);
        let word = search(root, "hello", &options(false, true, false), false).unwrap();
        assert_eq!(lines(&word).len(), 2);
        let re = search(root, r"hello\w+", &options(false, false, true), false).unwrap();
        assert_eq!(lines(&re), ["src/main.rs:2:let helloWorld = 1;"]);
        let plain = search(root, "a.ain", &options(false, false, false), false).unwrap();
        assert!(plain.files.is_empty());
        assert!(search(root, "(", &options(false, false, true), false).is_err());
    }

    #[test]
    fn cuts_long_lines_around_the_match() {
        let re = pattern("needle", &options(false, false, false)).unwrap();
        let line = format!("{}needle{}", "é".repeat(500), "x".repeat(500));
        let found = line_match(&line, 1, &re).unwrap();
        assert_eq!(found.preview.chars().count(), PREVIEW_CHARS);
        assert_eq!(found.preview_offset, 500 - CONTEXT_BEFORE as u32);
        let (s, e) = found.ranges[0];
        assert_eq!((s, e), (CONTEXT_BEFORE as u32, CONTEXT_BEFORE as u32 + 6));
    }
}
