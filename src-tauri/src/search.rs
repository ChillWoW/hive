//! The file panel's text search: a chat folder's files (the ones
//! `.gitignore` doesn't hide, as the panel lists them) read line by line for
//! a text or a regular expression. Binary files, files that aren't UTF-8 and
//! those past the editor's size are skipped, as the editor wouldn't show
//! them. A newer search stops the one before it.

use std::path::Path;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};

use grep_matcher::{LineTerminator, Matcher};
use grep_regex::{RegexMatcher, RegexMatcherBuilder};
use grep_searcher::sinks::UTF8;
use grep_searcher::{BinaryDetection, Searcher, SearcherBuilder};
use ignore::WalkState;
use outcode_proto::{FileMatches, TextMatch, TextQuery, TextSearch};

use crate::files::relative;

/// Matches listed at most; past this the search stops.
const MAX_MATCHES: usize = 2000;
/// Past this a file isn't searched (the editor doesn't read it either).
const MAX_FILE_SIZE: u64 = 8 * 1024 * 1024;
/// A preview's characters at most, and how many of them come before the match.
const PREVIEW_CHARS: usize = 200;
const PREVIEW_LEAD: usize = 24;

/// The id of the search asked for last; the others stop.
static LATEST: AtomicU64 = AtomicU64::new(0);

fn utf16(text: &str) -> u32 {
    text.encode_utf16().count() as u32
}

fn matcher(query: &TextQuery) -> Result<RegexMatcher, String> {
    RegexMatcherBuilder::new()
        .case_insensitive(!query.case_sensitive)
        .word(query.whole_word)
        .fixed_strings(!query.regex)
        // A match never spans lines; `$` holds before `\r\n` too.
        .line_terminator(Some(b'\n'))
        .crlf(true)
        .build(&query.text)
        .map_err(|error| {
            // The parser's message ends in `error: <what's wrong>`.
            let text = error.to_string();
            let reason = text.lines().last().unwrap_or_default();
            let reason = reason.strip_prefix("error: ").unwrap_or(reason);
            format!("Invalid regular expression: {reason}")
        })
}

/// The line around the match at `start..end` (bytes): from its first
/// non-blank character, or shortly before the match when that's far.
fn preview(line: &str, start: usize, end: usize) -> (String, u32, u32) {
    let indent = line.len() - line.trim_start().len();
    let mut from = indent.min(start);
    let mut text = String::new();
    if let Some((near, _)) = line[..start].char_indices().rev().nth(PREVIEW_LEAD - 1)
        && near > from
    {
        from = near;
        text.push('…');
    }
    let preview_start = utf16(&text) + utf16(&line[from..start]);
    let shown = line[from..]
        .char_indices()
        .nth(PREVIEW_CHARS)
        .map_or(line.len(), |(at, _)| from + at);
    text.push_str(&line[from..shown]);
    if shown < line.len() {
        text.push('…');
    }
    (text, preview_start, utf16(&line[start..end.min(shown)]))
}

/// `line`'s matches, pushed to `found`. False once `more` says to stop.
fn line_matches(
    matcher: &RegexMatcher,
    number: u64,
    line: &str,
    found: &mut Vec<TextMatch>,
    mut more: impl FnMut() -> bool,
) -> bool {
    let line = line.trim_end_matches(['\n', '\r']);
    // A byte order mark isn't in the editor's text.
    let line = if number == 1 { line.strip_prefix('\u{feff}').unwrap_or(line) } else { line };
    // Counted on from the match before, so a long line is walked once.
    let (mut at, mut column) = (0, 1);
    let mut go_on = true;
    let _ = matcher.find_iter(line.as_bytes(), |hit| {
        let (start, end) = (hit.start(), hit.end());
        if start == end || !line.is_char_boundary(start) || !line.is_char_boundary(end) {
            return true;
        }
        if !more() {
            go_on = false;
            return false;
        }
        column += utf16(&line[at..start]);
        at = start;
        let (preview, preview_start, preview_length) = preview(line, start, end);
        found.push(TextMatch {
            line: number as u32,
            column,
            length: utf16(&line[start..end]),
            preview,
            preview_start,
            preview_length,
        });
        true
    });
    go_on
}

/// The matches in the file at `path`; none when it can't be read as UTF-8 text.
fn file_matches(
    searcher: &mut Searcher,
    matcher: &RegexMatcher,
    path: &Path,
    mut more: impl FnMut() -> bool,
) -> Vec<TextMatch> {
    let mut found = Vec::new();
    let sink = UTF8(|number, line| Ok(line_matches(matcher, number, line, &mut found, &mut more)));
    match searcher.search_path(matcher, path, sink) {
        Ok(()) => found,
        Err(_) => Vec::new(),
    }
}

/// Every match of `query` under `root`, up to `MAX_MATCHES`; `stale` says
/// the search isn't wanted any more.
fn search(root: &Path, query: &TextQuery, stale: impl Fn() -> bool + Sync) -> Result<TextSearch, String> {
    if !root.is_dir() {
        return Err(format!("{} is not a folder", root.display()));
    }
    let matcher = matcher(query)?;
    let files = Mutex::new(Vec::new());
    let count = AtomicUsize::new(0);
    let truncated = AtomicBool::new(false);
    // Takes a place among the listed matches, unless they're all taken.
    let more = || {
        if count.fetch_add(1, Ordering::Relaxed) < MAX_MATCHES {
            return true;
        }
        truncated.store(true, Ordering::Relaxed);
        false
    };
    let done = || stale() || truncated.load(Ordering::Relaxed);

    ignore::WalkBuilder::new(root)
        .hidden(false)
        .require_git(false)
        .follow_links(false)
        .max_filesize(Some(MAX_FILE_SIZE))
        .filter_entry(|entry| entry.file_name() != ".git")
        .build_parallel()
        .run(|| {
            let matcher = matcher.clone();
            // A UTF-16 file reads as binary, as it does to the editor.
            let mut searcher = SearcherBuilder::new()
                .binary_detection(BinaryDetection::quit(0))
                .bom_sniffing(false)
                .line_terminator(LineTerminator::crlf())
                .build();
            let (files, more, done) = (&files, &more, &done);
            Box::new(move |entry| {
                if done() {
                    return WalkState::Quit;
                }
                let Ok(entry) = entry else { return WalkState::Continue };
                // Links aren't followed, as in the editor.
                if !entry.file_type().is_some_and(|kind| kind.is_file()) {
                    return WalkState::Continue;
                }
                let matches = file_matches(&mut searcher, &matcher, entry.path(), more);
                if let (false, Some(path)) = (matches.is_empty(), relative(root, entry.path())) {
                    files.lock().unwrap().push(FileMatches { path, matches });
                }
                WalkState::Continue
            })
        });

    let mut files = files.into_inner().unwrap();
    files.sort_by_cached_key(|file| file.path.to_lowercase());
    Ok(TextSearch { files, truncated: truncated.into_inner() })
}

/// Every place `query` matches in `cwd`'s files, by file. `id` names the
/// search: a later call stops this one, whose result then isn't whole.
#[tauri::command]
pub async fn search_text(cwd: String, query: TextQuery, id: u64) -> Result<TextSearch, String> {
    LATEST.store(id, Ordering::Relaxed);
    tauri::async_runtime::spawn_blocking(move || {
        search(Path::new(&cwd), &query, || LATEST.load(Ordering::Relaxed) != id)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn query(text: &str) -> TextQuery {
        TextQuery { text: text.into(), case_sensitive: false, whole_word: false, regex: false }
    }

    /// Each match as `path:line:column+length`.
    fn found(root: &Path, query: &TextQuery) -> Vec<String> {
        search(root, query, || false)
            .unwrap()
            .files
            .iter()
            .flat_map(|file| {
                file.matches
                    .iter()
                    .map(move |m| format!("{}:{}:{}+{}", file.path, m.line, m.column, m.length))
            })
            .collect()
    }

    #[test]
    fn finds_text_in_listed_files() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::create_dir_all(root.join("target")).unwrap();
        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::write(root.join(".gitignore"), "target/\n").unwrap();
        std::fs::write(root.join(".git/HEAD"), "needle").unwrap();
        std::fs::write(root.join("target/out.txt"), "needle").unwrap();
        std::fs::write(root.join("blob.bin"), b"needle\0needle").unwrap();
        std::fs::write(root.join("latin.txt"), b"caf\xe9 needle").unwrap();
        std::fs::write(root.join("a.txt"), "\u{feff}Needle, needles\r\nnone\r\n  the needle\r\n").unwrap();
        std::fs::write(root.join("src/b.rs"), "// 😀 a.b needle()\nlet axb = 1;\n").unwrap();

        assert_eq!(
            found(root, &query("needle")),
            ["a.txt:1:1+6", "a.txt:1:9+6", "a.txt:3:7+6", "src/b.rs:1:11+6"]
        );
        let exact = TextQuery { case_sensitive: true, whole_word: true, ..query("needle") };
        assert_eq!(found(root, &exact), ["a.txt:3:7+6", "src/b.rs:1:11+6"]);
        // Literal unless asked for a regular expression.
        assert_eq!(found(root, &query("a.b")), ["src/b.rs:1:7+3"]);
        let regex = TextQuery { regex: true, ..query("a.b|needles$") };
        assert_eq!(found(root, &regex), ["a.txt:1:9+7", "src/b.rs:1:7+3", "src/b.rs:2:5+3"]);
        assert!(search(root, &TextQuery { regex: true, ..query("a(") }, || false).is_err());
        assert!(search(root, &query("needle"), || true).unwrap().files.is_empty());
    }

    #[test]
    fn clips_long_lines_and_stops_at_the_cap() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let line = format!("    {}needle{}\n", "é".repeat(100), "x".repeat(400));
        std::fs::write(root.join("long.txt"), line).unwrap();
        std::fs::write(root.join("many.txt"), "ab ".repeat(MAX_MATCHES + 50)).unwrap();

        let result = search(root, &query("needle"), || false).unwrap();
        let hit = &result.files[0].matches[0];
        assert_eq!((hit.column, hit.length), (105, 6));
        assert!(hit.preview.starts_with('…') && hit.preview.ends_with('…'));
        assert_eq!(hit.preview.chars().count(), PREVIEW_CHARS + 2);
        let units: Vec<u16> = hit.preview.encode_utf16().collect();
        let (from, to) = (hit.preview_start as usize, (hit.preview_start + hit.preview_length) as usize);
        assert_eq!(String::from_utf16(&units[from..to]).unwrap(), "needle");
        assert!(!result.truncated);

        let result = search(root, &query("ab"), || false).unwrap();
        assert!(result.truncated);
        assert_eq!(result.files[0].matches.len(), MAX_MATCHES);
        assert_eq!(result.files[0].matches[1].preview, "ab ab ab ".repeat(PREVIEW_CHARS / 9 + 1)[..PREVIEW_CHARS].to_owned() + "…");
    }
}
