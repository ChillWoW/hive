/**
 * A unified git patch as files, hunks and lines (zeron's `parse_patch`,
 * `crates/ui/src/changes.rs`). Tolerant: unknown header lines are skipped, a
 * truncated hunk keeps what parsed.
 */

export type LineKind = "context" | "add" | "del" | "meta";

export type PatchLine = {
    kind: LineKind;
    oldNo?: number;
    newNo?: number;
    text: string;
};

export type Hunk = { header: string; lines: PatchLine[] };

export type FileStatus = "added" | "deleted" | "modified" | "renamed";

export type FileDiff = {
    /** The path after the change, relative to the checkout's root. */
    path: string;
    /** The path before a rename. */
    oldPath?: string;
    status: FileStatus;
    binary: boolean;
    /** Mode changes and the like. */
    notices: string[];
    hunks: Hunk[];
    additions: number;
    deletions: number;
    /** The largest line number on either side; sizes the gutters. */
    maxLine: number;
    /** Diff lines in all its hunks. */
    lineCount: number;
};

const stripPrefix = (path: string) =>
    path.startsWith("a/") || path.startsWith("b/") ? path.slice(2) : path;

function unquote(s: string) {
    const t = s.trim();
    if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
        return t.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    }
    return t;
}

/** The tail of `diff --git a/… b/…` as (old, new); git splits at the last ` b/`. */
function parsePaths(rest: string): [string, string] {
    let at = rest.lastIndexOf(' "b/');
    if (at === -1) at = rest.lastIndexOf(" b/");
    if (at === -1) {
        const p = stripPrefix(unquote(rest));
        return [p, p];
    }
    return [stripPrefix(unquote(rest.slice(0, at))), stripPrefix(unquote(rest.slice(at + 1)))];
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** The line without the `\r` a CRLF file leaves on it. */
const body = (raw: string) => (raw.endsWith("\r") ? raw.slice(1, -1) : raw.slice(1));

export function parsePatch(patch: string): FileDiff[] {
    const files: FileDiff[] = [];
    let file: FileDiff | undefined;
    let hunk: Hunk | undefined;
    let oldNo = 0;
    let newNo = 0;

    for (const raw of patch.split("\n")) {
        if (raw.startsWith("diff --git ")) {
            const [old, next] = parsePaths(raw.slice(11));
            file = {
                path: next,
                oldPath: old !== next ? old : undefined,
                status: "modified",
                binary: false,
                notices: [],
                hunks: [],
                additions: 0,
                deletions: 0,
                maxLine: 0,
                lineCount: 0
            };
            files.push(file);
            hunk = undefined;
            continue;
        }
        if (!file) continue;

        if (raw.startsWith("@@")) {
            const m = HUNK.exec(raw);
            if (m) {
                oldNo = Number(m[1]);
                newNo = Number(m[2]);
                hunk = { header: raw, lines: [] };
                file.hunks.push(hunk);
            }
            continue;
        }

        if (hunk) {
            let line: PatchLine | undefined;
            const marker = raw[0];
            if (marker === "+") {
                file.additions++;
                line = { kind: "add", newNo: newNo++, text: body(raw) };
            } else if (marker === "-") {
                file.deletions++;
                line = { kind: "del", oldNo: oldNo++, text: body(raw) };
            } else if (marker === " ") {
                line = { kind: "context", oldNo: oldNo++, newNo: newNo++, text: body(raw) };
            } else if (marker === "\\") {
                line = { kind: "meta", text: raw.slice(1).trim() };
            } else if (raw === "") {
                // The patch's last newline; a real empty context line is " ".
                continue;
            } else {
                hunk = undefined;
            }
            if (line) {
                file.maxLine = Math.max(file.maxLine, line.oldNo ?? 0, line.newNo ?? 0);
                file.lineCount++;
                hunk!.lines.push(line);
                continue;
            }
        }

        // File header territory.
        if (raw.startsWith("new file mode")) file.status = "added";
        else if (raw.startsWith("deleted file mode")) file.status = "deleted";
        else if (raw.startsWith("rename from ")) {
            file.status = "renamed";
            file.oldPath = unquote(raw.slice(12));
        } else if (raw.startsWith("rename to ")) {
            file.status = "renamed";
            file.path = unquote(raw.slice(10));
        } else if (raw.startsWith("Binary files") || raw.startsWith("GIT binary patch")) {
            file.binary = true;
        } else if (raw.startsWith("new mode ")) {
            file.notices.push(`Mode changed to ${raw.slice(9).trim()}`);
        } else if (raw.startsWith("+++ ")) {
            const next = raw.slice(4).trim();
            if (next === "/dev/null") file.status = "deleted";
            else if (!file.oldPath) file.path = stripPrefix(unquote(next));
        } else if (raw.startsWith("--- ") && raw.slice(4).trim() === "/dev/null") {
            file.status = "added";
        }
    }
    return files;
}

/**
 * `parsePatch`, reusing the files of `previous` whose section of the patch
 * is unchanged, so a refresh only re-renders the files that moved.
 */
export function parsePatchReusing(
    patch: string,
    previous: Map<string, FileDiff>
): { files: FileDiff[]; sections: Map<string, FileDiff> } {
    const sections = new Map<string, FileDiff>();
    const files: FileDiff[] = [];
    for (const section of patch.split(/\n(?=diff --git )/)) {
        const file = previous.get(section) ?? parsePatch(section)[0];
        if (!file) continue;
        sections.set(section, file);
        files.push(file);
    }
    return { files, sections };
}

/** The rows above a file's hunks: new / deleted / renamed / binary, then the parser's. */
export function fileNotices(file: FileDiff): string[] {
    const notices: string[] = [];
    if (file.status === "added") notices.push("New file");
    else if (file.status === "deleted") notices.push("Deleted file");
    else if (file.status === "renamed") notices.push(`Renamed from ${file.oldPath ?? "?"}`);
    if (file.binary) notices.push("Binary file — contents not shown");
    return [...notices, ...file.notices];
}

/** One split row: indices into a hunk's lines for the old and the new column. */
export type LinePair = [number | undefined, number | undefined];

/**
 * Pairs a hunk's lines into split rows (zeron's `split_pairs`): context sits
 * on both sides, and a run of deletions followed by additions lines up
 * index for index, the longer side's leftovers getting one-sided rows. A
 * `\ No newline` marker belongs to the side whose line it follows.
 */
export function splitPairs(lines: PatchLine[]): LinePair[] {
    const pairs: LinePair[] = [];
    let dels: number[] = [];
    let adds: number[] = [];
    let delMeta: number[] = [];
    let addMeta: number[] = [];
    let side: LineKind | undefined;

    const drain = (left: number[], right: number[]) => {
        for (let i = 0; i < Math.max(left.length, right.length); i++) {
            pairs.push([left[i], right[i]]);
        }
    };
    const flush = () => {
        drain(dels, adds);
        drain(delMeta, addMeta);
        dels = [];
        adds = [];
        delMeta = [];
        addMeta = [];
    };

    lines.forEach((line, i) => {
        switch (line.kind) {
            case "del":
                if (adds.length || delMeta.length || addMeta.length) flush();
                dels.push(i);
                side = "del";
                break;
            case "add":
                if (addMeta.length) flush();
                adds.push(i);
                side = "add";
                break;
            case "meta":
                if (side === "del") delMeta.push(i);
                else if (side === "add") addMeta.push(i);
                else {
                    delMeta.push(i);
                    addMeta.push(i);
                }
                break;
            case "context":
                flush();
                pairs.push([i, i]);
                side = "context";
        }
    });
    flush();
    return pairs;
}

export type DiffTotals = { files: number; additions: number; deletions: number };

export function totals(files: FileDiff[]): DiffTotals {
    let additions = 0;
    let deletions = 0;
    for (const f of files) {
        additions += f.additions;
        deletions += f.deletions;
    }
    return { files: files.length, additions, deletions };
}

/** Files this long start folded, as do lockfiles (generated, rarely read). */
const FOLD_LINES = 1500;
const LOCKFILE =
    /(^|\/)(package-lock\.json|bun\.lockb?|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|composer\.lock|Gemfile\.lock|poetry\.lock|go\.sum|uv\.lock)$/;

export const startsFolded = (file: FileDiff) =>
    file.lineCount > FOLD_LINES || LOCKFILE.test(file.path);
