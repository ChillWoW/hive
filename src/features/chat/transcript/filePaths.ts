import { platform } from "@/lib/platform";

/** A line (and maybe column) in a file, 1-based. */
export type LinePosition = { line: number; column?: number };

/** A file an agent named: its path as written, and maybe a line in it. */
type FileRef = { path: string; at?: LinePosition };

/** Where a file is: a folder and a path relative to it. */
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

/** A path as a comparison key: case folded on Windows. */
export const foldPath = (path: string) => {
    const p = path.replace(/\\/g, "/");
    return platform === "windows" ? p.toLowerCase() : p;
};

/** An absolute `/`-separated path with `.` and `..` folded away. */
function absolute(path: string): string | null {
    const drive = DRIVE.exec(path)?.[0];
    const rest = normalize(drive ? path.slice(drive.length) : path);
    if (rest === null) return null;
    return (drive ?? "/") + rest;
}

/**
 * Where `ref` is: inside `folder` (the chat's) when it is, as a path
 * relative to it; else an absolute path in its own parent folder.
 */
export function resolveFileRef(folder: string | undefined, ref: FileRef): FileTarget | null {
    const base = folder?.replace(/\\/g, "/").replace(/\/+$/, "");
    if (!isAbsolute(ref.path) && !base) return null;
    const full = absolute(isAbsolute(ref.path) ? ref.path : `${base}/${ref.path}`);
    if (!full) return null;
    if (folder && base) {
        const root = absolute(base);
        if (root && foldPath(full).startsWith(`${foldPath(root).replace(/\/$/, "")}/`)) {
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

/** The target's absolute path, `\`s under a Windows drive. */
export function fullPath(target: FileTarget): string {
    const sep = /^[a-z]:/i.test(target.cwd) && target.cwd.includes("\\") ? "\\" : "/";
    const base = target.cwd.replace(/[\\/]+$/, "");
    const path = sep === "\\" ? target.path.replace(/\//g, "\\") : target.path;
    return `${base}${sep}${path}`;
}

/** Text an inline code span could be a path in: no spaces, quotes or globs. */
const CODE_PATH = /^[^\s"'`<>|*?(){}[\]]+$/;
/** A last segment with an extension, so `foo.bar()` and words aren't paths. */
const HAS_EXTENSION = /[^/.]\.[a-z0-9]{1,12}$/i;
/**
 * An absolute path counts in a code span only from a drive or a well-known
 * root, so `/api/users.json` stays a route.
 */
const ABSOLUTE_ROOT =
    platform === "windows"
        ? /^[a-z]:\//i
        : /^\/(Users|home|tmp|private|var|etc|opt|usr|Library|Applications|Volumes|mnt|srv|root)\//;

/**
 * The file a code span names, if it plainly names one: a file the agent read
 * or changed (`known`, by `foldPath` of the absolute path), a relative path
 * with a folder and an extension, or an absolute one from a well-known root.
 * A bare `name.ext` counts only when it's known, so `console.log` stays code.
 */
export function codeFileTarget(
    text: string,
    folder: string | undefined,
    known: ReadonlySet<string>
): FileTarget | null {
    if (!CODE_PATH.test(text) || SCHEME.test(text)) return null;
    const ref = parseFileRef(text);
    if (!ref || !HAS_EXTENSION.test(ref.path)) return null;
    const target = resolveFileRef(folder, ref);
    if (!target) return null;
    if (known.has(foldPath(fullPath(target)))) return target;
    if (isAbsolute(ref.path)) return ABSOLUTE_ROOT.test(ref.path) ? target : null;
    return ref.path.includes("/") ? target : null;
}
