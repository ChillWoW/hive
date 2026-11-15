/** One line of a file change: kept, added or removed, numbered when known. */
export type DiffRow = {
    kind: "context" | "add" | "del";
    text: string;
    oldNo?: number;
    newNo?: number;
};

/** A file change (or a file as read), as the transcript draws it. */
export type FileDiff = {
    path: string;
    rows: DiffRow[];
    additions: number;
    deletions: number;
    /** The largest line number on either side; sizes the gutter (0: none). */
    maxLine: number;
    /** Only one side numbered: a new file, a file as read. */
    oneSide: boolean;
};

type DiffLine = { kind: "same" | "add" | "del"; text: string };

/** Past this many cells the LCS table is skipped for a plain replace. */
const MAX_CELLS = 400_000;

function splitLines(text: string): string[] {
    if (!text) return [];
    const lines = text.replace(/\r/g, "").split("\n");
    if (lines.at(-1) === "") lines.pop();
    return lines;
}

/**
 * A line diff of `before` → `after`: the longest common subsequence kept,
 * the rest as deletions then additions. Big inputs skip the table and show
 * everything removed then everything added, which is still right, just
 * coarser.
 */
export function diffLines(before: string, after: string): DiffLine[] {
    const a = splitLines(before);
    const b = splitLines(after);

    // Trim the shared head and tail first; most edits touch a few lines.
    let head = 0;
    while (head < a.length && head < b.length && a[head] === b[head]) head++;
    let tail = 0;
    while (
        tail < a.length - head &&
        tail < b.length - head &&
        a[a.length - 1 - tail] === b[b.length - 1 - tail]
    ) {
        tail++;
    }
    const midA = a.slice(head, a.length - tail);
    const midB = b.slice(head, b.length - tail);

    const out: DiffLine[] = a.slice(0, head).map((text) => ({ kind: "same", text }));
    if (midA.length * midB.length > MAX_CELLS) {
        for (const text of midA) out.push({ kind: "del", text });
        for (const text of midB) out.push({ kind: "add", text });
    } else {
        const n = midA.length;
        const m = midB.length;
        // lcs[i][j]: LCS length of midA[i..] and midB[j..].
        const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
        for (let i = n - 1; i >= 0; i--) {
            for (let j = m - 1; j >= 0; j--) {
                lcs[i]![j] =
                    midA[i] === midB[j]
                        ? lcs[i + 1]![j + 1]! + 1
                        : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
            }
        }
        let i = 0;
        let j = 0;
        while (i < n || j < m) {
            if (i < n && j < m && midA[i] === midB[j]) {
                out.push({ kind: "same", text: midA[i]! });
                i++;
                j++;
            } else if (i < n && (j === m || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) {
                out.push({ kind: "del", text: midA[i]! });
                i++;
            } else {
                out.push({ kind: "add", text: midB[j]! });
                j++;
            }
        }
    }
    for (const text of a.slice(a.length - tail)) out.push({ kind: "same", text });
    return out;
}

/** A numbered line as Claude's Read prints it: `   12→code` (or a tab). */
const NUMBERED = /^\s*(\d+)(?:→|\t)(.*)$/;

/**
 * A read tool's output as a `FileDiff` of unchanged lines: the CLI's line
 * numbers kept when every line has one, its notes dropped. Undefined when
 * nothing is left to show.
 */
export function toFileView(path: string, output: string): FileDiff | undefined {
    let text = output.replace(/\r/g, "");
    const reminder = text.indexOf("<system-reminder>");
    if (reminder !== -1) text = text.slice(0, reminder);
    const raw = text.replace(/\n+$/, "").split("\n");
    if (!raw.some((line) => line.trim())) return undefined;
    const numbered = raw.every((line) => NUMBERED.test(line));
    let maxLine = 0;
    const rows: DiffRow[] = raw.map((line) => {
        const m = numbered ? NUMBERED.exec(line) : null;
        if (!m) return { kind: "context", text: line };
        const no = Number(m[1]);
        maxLine = Math.max(maxLine, no);
        return { kind: "context", text: m[2]!, newNo: no };
    });
    return { path, rows, additions: 0, deletions: 0, maxLine, oneSide: true };
}

/**
 * `lines` as a `FileDiff` of `path`. Numbered from 1 only when the lines are
 * the whole file (`whole`); a snippet's real line numbers aren't known.
 */
export function toFileDiff(path: string, lines: DiffLine[], whole: boolean): FileDiff {
    let oldNo = 1;
    let newNo = 1;
    let additions = 0;
    let deletions = 0;
    const rows: DiffRow[] = lines.map(({ kind, text }) => {
        if (kind === "add") {
            additions++;
            return { kind, text, newNo: whole ? newNo++ : undefined };
        }
        if (kind === "del") {
            deletions++;
            return { kind, text, oldNo: whole ? oldNo++ : undefined };
        }
        return {
            kind: "context",
            text,
            oldNo: whole ? oldNo++ : undefined,
            newNo: whole ? newNo++ : undefined
        };
    });
    const oneSide = rows.every((row) => row.oldNo === undefined);
    return {
        path,
        rows,
        additions,
        deletions,
        maxLine: whole ? Math.max(oldNo, newNo) - 1 : 0,
        oneSide
    };
}
