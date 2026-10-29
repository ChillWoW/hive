//! OpenCode's history: `opencode*.db` (SQLite) under `$OPENCODE_DATA_DIR`,
//! else `$XDG_DATA_HOME/opencode`, else `~/.local/share/opencode`. 2.x keeps
//! assistant messages in `session_message`, 1.x in `message`; both carry
//! `tokens` and a `cost` (0 for models it can't price). Opened read-only;
//! messages are re-read from shortly before the newest one seen, by id.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::record::{CACHE_READ, CACHE_WRITE, INPUT, OUTPUT, REASONING};

pub fn data_dir() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("OPENCODE_DATA_DIR").filter(|d| !d.is_empty()) {
        return Some(dir.into());
    }
    if let Some(dir) = std::env::var_os("XDG_DATA_HOME").filter(|d| !d.is_empty()) {
        return Some(PathBuf::from(dir).join("opencode"));
    }
    crate::home().map(|h| h.join(".local").join("share").join("opencode"))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    #[serde(rename = "a")]
    pub at: i64,
    #[serde(rename = "m")]
    pub model: String,
    #[serde(rename = "s")]
    pub session: String,
    #[serde(rename = "p", default, skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    #[serde(rename = "t")]
    pub counts: [u64; 6],
    #[serde(rename = "c", default, skip_serializing_if = "Option::is_none")]
    pub cost: Option<f64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Database {
    /// The earliest creation time read from (Unix ms).
    pub from: i64,
    /// The newest message seen.
    pub through: i64,
    pub messages: HashMap<String, Message>,
}

/// Re-read this far back from the newest message, to catch ones that were
/// still streaming.
const OVERLAP_MS: i64 = 6 * 3_600_000;

pub struct Stats {
    pub found: bool,
    pub files: u32,
    pub error: Option<String>,
}

/// Brings `cache` (by database path) up to date for messages created from
/// `since` on.
pub fn scan(cache: &mut HashMap<String, Database>, since: i64) -> Stats {
    let mut stats = Stats { found: false, files: 0, error: None };
    let Some(dir) = data_dir() else { return stats };
    let Ok(entries) = std::fs::read_dir(&dir) else { return stats };
    let mut dbs: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with("opencode") && n.ends_with(".db"))
        })
        .collect();
    dbs.sort();
    for path in dbs {
        stats.found = true;
        let key = path.to_string_lossy().into_owned();
        let db = cache.entry(key.clone()).or_default();
        match read(&path, db, since) {
            Ok(()) => stats.files += 1,
            Err(e) => {
                stats.error.get_or_insert_with(|| format!("{key}: {e}"));
            }
        }
    }
    stats
}

fn read(path: &Path, db: &mut Database, since: i64) -> rusqlite::Result<()> {
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    conn.busy_timeout(Duration::from_millis(500))?;
    let fresh = db.messages.is_empty();
    let from = if fresh || since < db.from {
        since
    } else {
        db.through - OVERLAP_MS
    };
    let tables: Vec<String> = conn
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")?
        .query_map([], |r| r.get(0))?
        .collect::<Result<_, _>>()?;
    let has = |t: &str| tables.iter().any(|n| n == t);

    let mut through = db.through;
    // 1.x first, so 2.x wins for a message both hold.
    if has("message") {
        let directory = if has("session") { "s.directory" } else { "NULL" };
        let join = if has("session") { "LEFT JOIN session s ON s.id = m.session_id" } else { "" };
        let sql = format!(
            "SELECT m.id, m.session_id, m.time_created,
                    json_extract(m.data, '$.role', '$.modelID', '$.providerID', '$.tokens', '$.cost', '$.path.cwd'),
                    {directory}
             FROM message m {join}
             WHERE m.time_created >= ?1"
        );
        collect(&conn, &sql, from, db, &mut through)?;
    }
    if has("session_message") {
        let (directory, join) = if has("session_v2") {
            ("s.directory", "LEFT JOIN session_v2 s ON s.id = m.session_id")
        } else {
            ("NULL", "")
        };
        let sql = format!(
            "SELECT m.id, m.session_id, m.time_created,
                    json_extract(m.data, '$.type', '$.model.id', '$.model.providerID', '$.tokens', '$.cost', '$.path.cwd'),
                    {directory}
             FROM session_message m {join}
             WHERE m.time_created >= ?1 AND m.type = 'assistant'"
        );
        collect(&conn, &sql, from, db, &mut through)?;
    }
    db.from = if fresh { from } else { db.from.min(from) };
    db.through = through;
    Ok(())
}

fn collect(
    conn: &Connection,
    sql: &str,
    from: i64,
    db: &mut Database,
    through: &mut i64,
) -> rusqlite::Result<()> {
    let mut stmt = conn.prepare(sql)?;
    let mut rows = stmt.query([from])?;
    while let Some(row) = rows.next()? {
        let id: String = row.get(0)?;
        let session: String = row.get(1)?;
        let at: i64 = row.get(2)?;
        // [role (1.x only), model, provider, tokens, cost, cwd (1.x only)], one parse.
        let fields: Option<String> = row.get(3)?;
        let directory: Option<String> = row.get::<_, Option<String>>(4).unwrap_or(None);
        *through = (*through).max(at);
        let Some(Value::Array(fields)) = fields.and_then(|f| serde_json::from_str(&f).ok()) else {
            continue;
        };
        let text = |i: usize| fields.get(i).and_then(Value::as_str).filter(|s| !s.is_empty());
        if text(0).is_some_and(|role| role != "assistant") {
            continue;
        }
        let Some(model) = text(1).map(str::to_owned) else { continue };
        let provider = text(2).map(str::to_owned);
        let Some(tokens) = fields.get(3).filter(|t| t.is_object()) else { continue };
        let cost = fields.get(4).and_then(Value::as_f64);
        let project = text(5).map(str::to_owned).or(directory);
        let n = |p: &str| tokens.pointer(p).and_then(Value::as_u64).unwrap_or(0);
        let mut counts = [0; 6];
        counts[INPUT] = n("/input");
        counts[CACHE_READ] = n("/cache/read");
        counts[CACHE_WRITE] = n("/cache/write");
        counts[REASONING] = n("/reasoning");
        counts[OUTPUT] = n("/output") + counts[REASONING];
        if counts.iter().all(|c| *c == 0) {
            continue;
        }
        // The provider prefix finds the price (`openrouter/deepseek/…`).
        let model = match provider.filter(|p| !p.is_empty()) {
            Some(p) if !model.starts_with(&format!("{p}/")) => format!("{p}/{model}"),
            _ => model,
        };
        db.messages.insert(
            id,
            Message {
                at,
                model,
                session,
                project,
                counts,
                cost: cost.filter(|c| c.is_finite() && *c > 0.0),
            },
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_both_schemas() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("opencode.db");
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(
            r#"
            CREATE TABLE session_v2 (id TEXT PRIMARY KEY, directory TEXT NOT NULL);
            CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, time_created INTEGER, data TEXT);
            CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
            INSERT INTO session_v2 VALUES ('ses_2', 'E:\dev\pwrs');
            INSERT INTO session_message VALUES ('msg_a', 'ses_2', 'assistant', 2000,
              '{"model":{"id":"deepseek/deepseek-v4.1-flash-1017","providerID":"openrouter"},"cost":0.5,"tokens":{"input":361,"output":461,"reasoning":10,"cache":{"read":17408,"write":0}}}');
            INSERT INTO session_message VALUES ('msg_u', 'ses_2', 'user', 2001, '{}');
            INSERT INTO message VALUES ('msg_b', 'ses_1', 1000,
              '{"role":"assistant","modelID":"gpt-5.3-codex","providerID":"openai","cost":0,"path":{"cwd":"C:\\x"},"tokens":{"input":5,"output":6,"reasoning":0,"cache":{"read":0,"write":0}}}');
            "#,
        )
        .unwrap();
        drop(conn);

        let mut db = Database::default();
        read(&path, &mut db, 0).unwrap();
        assert_eq!(db.messages.len(), 2);
        let a = &db.messages["msg_a"];
        assert_eq!(a.model, "openrouter/deepseek/deepseek-v4.1-flash-1017");
        assert_eq!(a.counts, [361, 17408, 0, 471, 10, 0]);
        assert_eq!(a.cost, Some(0.5));
        assert_eq!(a.project.as_deref(), Some("E:\\dev\\pwrs"));
        let b = &db.messages["msg_b"];
        assert_eq!(b.model, "openai/gpt-5.3-codex");
        assert_eq!(b.cost, None);
        assert_eq!(b.project.as_deref(), Some("C:\\x"));
        assert_eq!(db.through, 2000);
    }
}
