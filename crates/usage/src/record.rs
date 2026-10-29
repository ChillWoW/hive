//! One model request as a history file records it, and the per-file string
//! table records point into (so the scan cache holds each model, session
//! and folder once per file).

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

/// `project` / `session` when the history doesn't say.
pub const NONE: u32 = u32::MAX;

/// Token counts as stored: uncached input, cache read, cache write, output
/// (reasoning included), reasoning, and the part of cache write held for an
/// hour (priced higher by Anthropic).
pub type Counts = [u64; 6];

pub const INPUT: usize = 0;
pub const CACHE_READ: usize = 1;
pub const CACHE_WRITE: usize = 2;
pub const OUTPUT: usize = 3;
pub const REASONING: usize = 4;
pub const CACHE_WRITE_1H: usize = 5;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Record {
    /// Unix ms.
    #[serde(rename = "a")]
    pub at: i64,
    #[serde(rename = "m")]
    pub model: u32,
    #[serde(rename = "s")]
    pub session: u32,
    #[serde(rename = "p")]
    pub project: u32,
    #[serde(rename = "t")]
    pub counts: Counts,
    /// What the CLI said it cost, when it says.
    #[serde(rename = "c", default, skip_serializing_if = "Option::is_none")]
    pub cost: Option<f64>,
    /// Fast mode / priority tier.
    #[serde(rename = "f", default, skip_serializing_if = "is_false")]
    pub fast: bool,
    /// Identifies a request copied into several files (0: none).
    #[serde(rename = "k", default, skip_serializing_if = "is_zero")]
    pub key: u64,
}

fn is_false(b: &bool) -> bool {
    !*b
}

fn is_zero(n: &u64) -> bool {
    *n == 0
}


/// Records parsed from one file, with their strings.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Records {
    pub strings: Vec<String>,
    pub records: Vec<Record>,
    /// `key` → index in `records`, while parsing (not cached).
    #[serde(skip)]
    by_key: HashMap<u64, usize>,
    #[serde(skip)]
    interned: HashMap<String, u32>,
    #[serde(skip)]
    indexed: bool,
}

impl Records {
    /// Rebuilds the lookups after coming back from the cache.
    fn index(&mut self) {
        if self.indexed {
            return;
        }
        self.indexed = true;
        for (i, s) in self.strings.iter().enumerate() {
            self.interned.insert(s.clone(), i as u32);
        }
        for (i, r) in self.records.iter().enumerate() {
            if r.key != 0 {
                self.by_key.insert(r.key, i);
            }
        }
    }

    pub fn intern(&mut self, s: &str) -> u32 {
        self.index();
        if let Some(&i) = self.interned.get(s) {
            return i;
        }
        let i = self.strings.len() as u32;
        self.strings.push(s.to_owned());
        self.interned.insert(s.to_owned(), i);
        i
    }

    pub fn string(&self, i: u32) -> Option<&str> {
        self.strings.get(i as usize).map(String::as_str)
    }

    /// Adds a record; one with a key already seen in this file merges into
    /// it, keeping the larger count of each kind (the CLI writes a message's
    /// usage once per content block, and a cut-off one may lag behind).
    pub fn push(&mut self, record: Record) {
        self.index();
        if record.key != 0 {
            if let Some(&i) = self.by_key.get(&record.key) {
                let held = &mut self.records[i];
                for (a, b) in held.counts.iter_mut().zip(record.counts) {
                    *a = (*a).max(b);
                }
                if held.cost.is_none() {
                    held.cost = record.cost;
                }
                return;
            }
            self.by_key.insert(record.key, self.records.len());
        }
        self.records.push(record);
    }
}

/// FNV-1a, 64-bit: stable across builds, so keys and anchors can be cached.
pub fn fnv(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        hash ^= u64::from(*b);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    hash.max(1)
}

/// RFC 3339 (`2026-10-29T21:17:41.022Z`, or with an offset) to Unix ms.
pub fn parse_time(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() < 19 || b[4] != b'-' || b[7] != b'-' || (b[10] != b'T' && b[10] != b' ') {
        return None;
    }
    let num = |from: usize, len: usize| -> Option<i64> {
        let mut n = 0i64;
        for &c in b.get(from..from + len)? {
            if !c.is_ascii_digit() {
                return None;
            }
            n = n * 10 + i64::from(c - b'0');
        }
        Some(n)
    };
    let (y, mo, d) = (num(0, 4)?, num(5, 2)?, num(8, 2)?);
    let (h, mi, sec) = (num(11, 2)?, num(14, 2)?, num(17, 2)?);
    let mut i = 19;
    let mut ms = 0i64;
    if b.get(i) == Some(&b'.') {
        i += 1;
        let start = i;
        while i < b.len() && b[i].is_ascii_digit() {
            if i - start < 3 {
                ms = ms * 10 + i64::from(b[i] - b'0');
            }
            i += 1;
        }
        for _ in (i - start).min(3)..3 {
            ms *= 10;
        }
    }
    let offset_min = match b.get(i) {
        None | Some(b'Z') | Some(b'z') => 0,
        Some(&sign @ (b'+' | b'-')) => {
            let oh = num(i + 1, 2)?;
            let om = if b.get(i + 3) == Some(&b':') { num(i + 4, 2)? } else { num(i + 3, 2)? };
            let m = oh * 60 + om;
            if sign == b'+' { m } else { -m }
        }
        _ => return None,
    };
    let days = days_from_civil(y, mo, d);
    Some(((days * 86_400 + h * 3600 + mi * 60 + sec) - offset_min * 60) * 1000 + ms)
}

/// Days since 1970-01-01 (Howard Hinnant's algorithm).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_rfc3339() {
        assert_eq!(parse_time("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_time("2026-10-29T21:17:41.022Z"), Some(1_793_308_661_022));
        assert_eq!(parse_time("2026-10-29T23:17:41.022+02:00"), Some(1_793_308_661_022));
        assert_eq!(parse_time("2026-10-29T21:17:41.5Z"), Some(1_793_308_661_500));
        assert_eq!(parse_time("2026-10-29T21:17:41.123456Z"), Some(1_793_308_661_123));
        assert_eq!(parse_time("nope"), None);
    }

    #[test]
    fn merges_repeats_by_key() {
        let mut r = Records::default();
        let rec = |out: u64| Record {
            at: 1,
            model: 0,
            session: NONE,
            project: NONE,
            counts: [1, 2, 3, out, 0, 0],
            cost: None,
            fast: false,
            key: 7,
        };
        r.push(rec(10));
        r.push(rec(40));
        r.push(rec(20));
        assert_eq!(r.records.len(), 1);
        assert_eq!(r.records[0].counts[OUTPUT], 40);
    }
}
