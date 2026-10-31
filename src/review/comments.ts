import type { FileDiff, PatchLine } from "@/diff/patch";
import { platform } from "@/lib/platform";

/**
 * Comments on lines of the diff tab, kept with a chat's draft and sent with
 * its next prompt: appended as a `<diff_comments>` block the agent reads and
 * the transcript draws as cards (`splitDiffComments`).
 */

/** A line of a diff: a removed line by its old number, any other by its new one. */
export type LineRef = { side: "old" | "new"; no: number };

export type DiffComment = {
    id: string;
    /** The checkout root `path` is relative to. */
    root: string;
    /** Where the agent works (the diff tab's folder); the prompt's paths are relative to it. */
    folder: string;
    /** The file, relative to `root`. */
    path: string;
    start: LineRef;
    end: LineRef;
    /** The lines commented on, each with its `+` / `-` / ` ` marker. */
    code: string;
    body: string;
};

/** The ref a diff line is commented by; none for a meta line. */
export function lineRef(line: PatchLine): LineRef | null {
    if (line.kind === "meta") return null;
    if (line.kind === "del") return line.oldNo === undefined ? null : { side: "old", no: line.oldNo };
    return line.newNo === undefined ? null : { side: "new", no: line.newNo };
}

export const refKey = (ref: LineRef) => `${ref.side}:${ref.no}`;
export const sameRef = (a: LineRef, b: LineRef) => a.side === b.side && a.no === b.no;

const MAX_CODE_LINES = 24;
const marker = (line: PatchLine) => (line.kind === "add" ? "+" : line.kind === "del" ? "-" : " ");

/**
 * The file's lines from `a` to `b` in diff order (either way round), as
 * `[start, end, code]`; null when either isn't in the file any more.
 */
export function rangeOf(
    file: FileDiff,
    a: LineRef,
    b: LineRef
): [LineRef, LineRef, string] | null {
    const lines = file.hunks.flatMap((h) => h.lines);
    const find = (ref: LineRef) =>
        lines.findIndex((line) => {
            const r = lineRef(line);
            return r !== null && sameRef(r, ref);
        });
    let from = find(a);
    let to = find(b);
    if (from === -1 || to === -1) return null;
    if (from > to) [from, to] = [to, from];
    const picked = lines.slice(from, to + 1).filter((l) => l.kind !== "meta");
    let code = picked.map((l) => `${marker(l)} ${l.text}`);
    if (code.length > MAX_CODE_LINES) {
        const half = MAX_CODE_LINES / 2;
        code = [...code.slice(0, half), "  …", ...code.slice(-half)];
    }
    return [lineRef(lines[from]!)!, lineRef(lines[to]!)!, code.join("\n")];
}

/** `12`, `12-14`, `old 12`, `old 12-14`, `old 12 - 14` (removed through added). */
export function linesLabel(start: LineRef, end: LineRef): string {
    const one = (r: LineRef) => (r.side === "old" ? `old ${r.no}` : `${r.no}`);
    if (sameRef(start, end)) return one(start);
    if (start.side === end.side) return `${one(start)}-${end.no}`;
    return `${one(start)} - ${one(end)}`;
}

/** The comment's line range for people: `L12`, `L12–14`, `old L12`. */
export function linesTitle(start: LineRef, end: LineRef): string {
    return labelTitle(linesLabel(start, end));
}

/** A `linesLabel` for people. */
export function labelTitle(label: string): string {
    return label.replace(/(^|old |- )(\d)/g, "$1L$2").replace(/(\d)-(\d)/, "$1–$2");
}

const norm = (path: string) => path.replace(/\\/g, "/").replace(/\/+$/, "");

/**
 * `path` (relative to `root`) as the agent in `folder` should read it:
 * relative to the folder when it's inside it, else in full.
 */
export function promptPath(folder: string, root: string, path: string): string {
    if (!root) return path;
    const r = norm(root);
    const f = norm(folder);
    const same = (a: string, b: string) =>
        platform === "windows" ? a.toLowerCase() === b.toLowerCase() : a === b;
    if (same(f, r)) return path;
    if (f.length > r.length && same(f.slice(0, r.length), r) && f[r.length] === "/") {
        const sub = f.slice(r.length + 1);
        if (path.startsWith(`${sub}/`)) return path.slice(sub.length + 1);
    }
    return `${r}/${path}`;
}

const OPEN = "<diff_comments>";
const CLOSE = "</diff_comments>";
const INTRO =
    "Review comments on lines of the diff (paths relative to the working directory; line numbers are the file's current ones unless marked old):";

const attr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/\n/g, " ");
const unattr = (s: string) => s.replace(/&quot;/g, '"').replace(/&amp;/g, "&");

/** The prompt with the comments appended (the prompt alone when there are none). */
export function withDiffComments(prompt: string, comments: DiffComment[]): string {
    if (comments.length === 0) return prompt;
    const blocks = comments.map((c) => {
        const file = promptPath(c.folder, c.root, c.path);
        return [
            `<comment file="${attr(file)}" lines="${linesLabel(c.start, c.end)}">`,
            "```diff",
            c.code,
            "```",
            c.body.trim(),
            "</comment>"
        ].join("\n");
    });
    const block = [OPEN, INTRO, ...blocks, CLOSE].join("\n");
    return prompt ? `${prompt}\n\n${block}` : block;
}

/** A comment as read back from a sent prompt. */
export type SentDiffComment = { file: string; lines: string; code: string; body: string };

const COMMENT =
    /<comment file="([^"]*)" lines="([^"]*)">\n```diff\n([\s\S]*?)\n```\n([\s\S]*?)\n<\/comment>/g;

/** A prompt's own text and the comments it carries (none for a plain prompt). */
export function splitDiffComments(text: string): { prompt: string; comments: SentDiffComment[] } {
    const at = text.lastIndexOf(OPEN);
    const end = text.lastIndexOf(CLOSE);
    if (at === -1 || end < at || text.slice(end + CLOSE.length).trim()) {
        return { prompt: text, comments: [] };
    }
    const comments = [...text.slice(at, end).matchAll(COMMENT)].map((m) => ({
        file: unattr(m[1]!),
        lines: m[2]!,
        code: m[3]!,
        body: m[4]!
    }));
    if (comments.length === 0) return { prompt: text, comments: [] };
    return { prompt: text.slice(0, at).trimEnd(), comments };
}

/** `linesLabel` read back. */
function parseLines(label: string): [LineRef, LineRef] | null {
    const ref = (s: string): LineRef | null => {
        const m = /^(old )?(\d+)$/.exec(s.trim());
        return m ? { side: m[1] ? "old" : "new", no: Number(m[2]) } : null;
    };
    const mixed = label.split(" - ");
    if (mixed.length === 2) {
        const [a, b] = mixed.map(ref);
        return a && b ? [a, b] : null;
    }
    const m = /^(old )?(\d+)(?:-(\d+))?$/.exec(label.trim());
    if (!m) return null;
    const side = m[1] ? "old" : "new";
    return [
        { side, no: Number(m[2]) },
        { side, no: Number(m[3] ?? m[2]) }
    ];
}

/**
 * A sent prompt's comments as draft comments again (a queued prompt taken
 * back to edit). Their paths are already the agent's, so they keep no root
 * and don't show in the diff.
 */
export function restoredComments(sent: SentDiffComment[]): DiffComment[] {
    return sent.flatMap((c) => {
        const lines = parseLines(c.lines);
        if (!lines) return [];
        return [
            {
                id: crypto.randomUUID(),
                root: "",
                folder: "",
                path: c.file,
                start: lines[0],
                end: lines[1],
                code: c.code,
                body: c.body
            }
        ];
    });
}
