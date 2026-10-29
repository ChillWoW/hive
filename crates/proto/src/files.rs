//! A folder's files, for the composer's `@` menu and the file panel.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// A file or folder under a chat's folder.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceEntry {
    /// Relative to the folder, `/`-separated, without a trailing slash.
    pub path: String,
    pub dir: bool,
}

/// One entry of a folder, as the file panel's tree lists it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryEntry {
    /// Relative to the chat's folder, `/`-separated, without a trailing slash.
    pub path: String,
    pub dir: bool,
    /// Hidden by `.gitignore`; listed only when everything is asked for.
    pub ignored: bool,
}

/// Why an open file can't be edited.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ReadOnlyReason {
    /// Over the editable size; shown, but not editable.
    TooLarge,
    /// Holds a NUL byte.
    Binary,
    /// Not UTF-8.
    UnsupportedEncoding,
    /// Both `\n` and `\r\n`; saving would have to pick one.
    MixedLineEndings,
    /// A link; never followed.
    Symlink,
}

/// How a file's lines end, so a save writes them back the same way.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum LineEnding {
    Lf,
    Crlf,
}

/// A file read for the editor (`read_file`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct FileText {
    /// Its text with `\n` line endings; none when it's binary, not UTF-8 or
    /// past the preview size.
    pub text: Option<String>,
    /// SHA-256 of the bytes on disk, hex; a save must name it.
    pub hash: String,
    #[ts(type = "number")]
    pub size: u64,
    pub line_ending: LineEnding,
    /// Starts with a UTF-8 byte order mark, kept on save.
    pub bom: bool,
    pub read_only: Option<ReadOnlyReason>,
}

/// What a save (`write_file`) did.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum WriteOutcome {
    /// Saved; the new bytes' hash.
    #[serde(rename_all = "camelCase")]
    Written { hash: String },
    /// The file changed (or went) since it was read, so nothing was written.
    Conflict { deleted: bool },
}
