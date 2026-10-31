import type { LinePosition } from "@/editor";
import { platform } from "@/lib/platform";
import type { WorkspaceEntry } from "@/proto";

/** A file an agent named: its path as written, and maybe a line in it. */
export type FileRef = { path: string; at?: LinePosition };

/** Where a file opens: a folder and a path relative to it. */
export type FileTarget = { cwd: string; path: string; at?: LinePosition };

/** `:12`, `:12:5`, `:12-20`, `#L12`, `#L12C5`, `#L12-L20` after a path. */
const LINE_SUFFIX = /(?::(\d+)(?::(\d+))?(?:-\d+)?|#L(\d+)(?:C(\d+))?(?:-L?\d+)?)$/;
/** A URL scheme that isn't a Windows drive letter. */
const SCHEME = /^[a-z][a-z0-9+.-]+:/i;
const DRIVE = /^[a-z]:\//i;

const decode = (text: string) => {
    try {
        return decodeURIComponent(text);
    } catch {
        return text;
    }
};

/**
 * Reads a link target or a code span as a file reference: a relative or
 * absolute path (either slash) or a `file:` URL, with an optional line
 * suffix. Null for web URLs and other schemes.
 */
export function parseFileRef(raw: string): FileRef | null {
    let text = raw.trim();
    if (!text || text.startsWith("#")) return null;
    if (/^file:/i.test(text)) {
        try {
            const url = new URL(text);
            text = decode(url.pathname) + url.hash;
            // `file:///C:/x` → `/C:/x`
            if (/^\/[a-z]:\//i.test(text)) text = text.slice(1);
        } catch {
            return null;
        }
    } else {
        if (SCHEME.test(text)) return null;
        text = decode(text);
    }
    text = text.replace(/\\/g, "/");
    let at: LinePosition | undefined;
    const suffix = LINE_SUFFIX.exec(text);
    if (suffix) {
        const line = Number(suffix[1] ?? suffix[3]);
        const column = suffix[2] ?? suffix[4];
        if (line > 0) at = column ? { line, column: Number(column) } : { line };
        text = text.slice(0, suffix.index);
    }
    if (!text || text.endsWith("/") || text.startsWith("~")) return null;
    return { path: text, at };
}

const isAbsolute = (path: string) => path.startsWith("/") || DRIVE.test(path);

/** `.` and `..` folded away; null when `..` climbs above the start. */
function normalize(path: string): string | null {
    const out: string[] = [];
    for (const part of path.split("/")) {
        if (part === "" || part === ".") continue;
        if (part === "..") {
            if (!out.length) return null;
            out.pop();
        } else out.push(part);
    }
    return out.join("/");
}

const fold = (path: string) => (platform === "windows" ? path.toLowerCase() : path);

/** An absolute `/`-separated path with `.` and `..` folded away. */
function absolute(path: string): string | null {
    const drive = DRIVE.exec(path)?.[0];
    const rest = normalize(drive ? path.slice(drive.length) : path);
    if (rest === null) return null;
    return (drive ?? "/") + rest;
}

/**
 * Where `ref` opens: inside `folder` (the chat's) when it is, as a path
 * relative to it; else an absolute path opens in its own parent folder.
 */
export function resolveFileRef(folder: string | undefined, ref: FileRef): FileTarget | null {
    const base = folder?.replace(/\\/g, "/").replace(/\/+$/, "");
    if (!isAbsolute(ref.path) && !base) return null;
    const full = absolute(isAbsolute(ref.path) ? ref.path : `${base}/${ref.path}`);
    if (!full) return null;
    if (folder && base) {
        const root = absolute(base);
        if (root && fold(full).startsWith(`${fold(root).replace(/\/$/, "")}/`)) {
            const path = full.slice(root.replace(/\/$/, "").length + 1);
            if (path) return { cwd: folder, path, at: ref.at };
        }
    }
    const cut = full.lastIndexOf("/");
    const name = full.slice(cut + 1);
    if (!name) return null;
    let parent = full.slice(0, cut);
    if (!parent || /^[a-z]:$/i.test(parent)) parent += "/";
    return { cwd: parent, path: name, at: ref.at };
}

/** A folder listing's files by path and by name (for names given bare). */
export type FileIndex = { paths: Set<string>; byName: Map<string, string[]> };

const indexes = new WeakMap<WorkspaceEntry[], FileIndex>();

export function fileIndex(entries: WorkspaceEntry[]): FileIndex {
    let index = indexes.get(entries);
    if (!index) {
        index = { paths: new Set(), byName: new Map() };
        for (const entry of entries) {
            if (entry.dir) continue;
            const key = fold(entry.path);
            index.paths.add(key);
            const name = key.slice(key.lastIndexOf("/") + 1);
            const list = index.byName.get(name);
            if (list) list.push(entry.path);
            else index.byName.set(name, [entry.path]);
        }
        indexes.set(entries, index);
    }
    return index;
}

/** Text an inline code span could be a path in: no spaces, quotes or globs. */
const CODE_PATH = /^[^\s"'`<>|*?(){}[\]]+$/;
/** A last segment with an extension, so `foo.bar()` and words aren't paths. */
const HAS_EXTENSION = /[^/.]\.[a-z0-9]{1,12}$/i;
/**
 * An absolute path outside the chat's folder counts in a code span only from
 * a drive or a well-known root, so `/api/users.json` stays a route.
 */
const OUTSIDE_ROOT =
    platform === "windows"
        ? /^[a-z]:\//i
        : /^\/(Users|home|tmp|private|var|etc|opt|usr|Library|Applications|Volumes|mnt|srv|root)\//;

/**
 * The file a code span names, if it names one: a path to a file listed in
 * `folder` (or a bare name only one listed file has), or an absolute path
 * outside it that looks like a file.
 */
export function codeFileTarget(
    text: string,
    folder: string | undefined,
    index: FileIndex | undefined
): FileTarget | null {
    if (!folder || !CODE_PATH.test(text) || SCHEME.test(text)) return null;
    const ref = parseFileRef(text);
    if (!ref) return null;
    const target = resolveFileRef(folder, ref);
    if (!target) return null;
    if (target.cwd !== folder) {
        return HAS_EXTENSION.test(target.path) && OUTSIDE_ROOT.test(ref.path) ? target : null;
    }
    if (!index) return null;
    if (index.paths.has(fold(target.path))) return target;
    if (!ref.path.includes("/")) {
        const matches = index.byName.get(fold(ref.path));
        if (matches?.length === 1) return { cwd: folder, path: matches[0], at: ref.at };
    }
    return null;
}
