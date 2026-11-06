/**
 * Big pastes, folded to a chip in the composer and in sent prompts alike.
 * Only drawn that way: the text stays in the prompt as is. A paste is known
 * by a fingerprint (length, hash, first characters), persisted as
 * `hive.pastes`, so a draft or a sent prompt holding it folds it again after
 * a reload, without keeping the text itself twice.
 */

const PASTE_LINES = 8;
const PASTE_CHARS = 1000;
const HEAD = 48;
const MAX = 300;
const KEY = "hive.pastes";

export type Span = { from: number; to: number };

type Print = { len: number; hash: number; head: string };

export const isBigPaste = (text: string) =>
    text.length >= PASTE_CHARS || text.split("\n").length >= PASTE_LINES;

/** Lines a paste spans, a trailing newline not counted. */
export const pasteLines = (raw: string) => raw.replace(/\n$/, "").split("\n").length;

function hashOf(text: string, from = 0, to = text.length): number {
    let h = 0x811c9dc5;
    for (let i = from; i < to; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}

const printOf = (raw: string): Print => ({
    len: raw.length,
    hash: hashOf(raw),
    head: raw.slice(0, HEAD)
});

const same = (a: Print, b: Print) => a.len === b.len && a.hash === b.hash;

function load(): Print[] {
    try {
        const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
        return Array.isArray(parsed) ? (parsed as Print[]) : [];
    } catch {
        return [];
    }
}

/** Oldest first. */
let prints: Print[] = load();
let version = 0;
const listeners = new Set<() => void>();

function save() {
    version++;
    try {
        localStorage.setItem(KEY, JSON.stringify(prints));
    } catch {
        // Storage full: kept in memory.
    }
    for (const listener of listeners) listener();
}

/** Folds `raw` wherever it shows up from now on. */
export function rememberPaste(raw: string) {
    const print = printOf(raw);
    const at = prints.findIndex((p) => same(p, print));
    if (at === prints.length - 1 && at !== -1) return;
    if (at !== -1) prints.splice(at, 1);
    prints.push(print);
    if (prints.length > MAX) prints = prints.slice(-MAX);
    save();
}

/** Unfolded by the user: shown as text from now on. */
export function forgetPaste(raw: string) {
    const print = printOf(raw);
    const next = prints.filter((p) => !same(p, print));
    if (next.length === prints.length) return;
    prints = next;
    save();
}

/** Where known pastes are in `text`, in order, longest first on overlap. */
export function findPastes(text: string): Span[] {
    const spans: Span[] = [];
    const candidates = prints.filter((p) => p.len <= text.length).sort((a, b) => b.len - a.len);
    for (const p of candidates) {
        for (let at = text.indexOf(p.head); at !== -1; at = text.indexOf(p.head, at + 1)) {
            const to = at + p.len;
            if (to > text.length) break;
            if (spans.some((s) => s.from < to && s.to > at)) continue;
            if (hashOf(text, at, to) !== p.hash) continue;
            spans.push({ from: at, to });
            at = to - 1;
        }
    }
    return spans.sort((a, b) => a.from - b.from);
}

/** Changes whenever the known pastes do (for `useSyncExternalStore`). */
export const pastesVersion = () => version;

export function subscribePastes(listener: () => void) {
    listeners.add(listener);
    return () => void listeners.delete(listener);
}
