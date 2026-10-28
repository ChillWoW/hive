export type DiffLine = { kind: "same" | "add" | "del"; text: string };

/** Past this many cells the LCS table is skipped for a plain replace. */
const MAX_CELLS = 400_000;

function splitLines(text: string): string[] {
    if (!text) return [];
    const lines = text.split("\n");
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

export function countChanges(lines: DiffLine[]) {
    let added = 0;
    let removed = 0;
    for (const l of lines) {
        if (l.kind === "add") added++;
        else if (l.kind === "del") removed++;
    }
    return { added, removed };
}
