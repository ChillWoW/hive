import type {
    DirectoryEntry,
    TextSearchOptions,
    TextSearchResult,
    WorkspaceEntry
} from "@/proto";
import { backend } from "@/lib/backend";
import { baseName } from "@/lib/paths";

/** A made-up project for plain `bun run dev`, where there's no backend. */
let FAKE: WorkspaceEntry[] = [
    "src/",
    "src/chat/",
    "src/composer/",
    "src-tauri/",
    "README.md",
    "package.json",
    "tsconfig.json",
    "vite.config.ts",
    "src/App.tsx",
    "src/main.tsx",
    "src/index.css",
    "src/chat/ChatView.tsx",
    "src/composer/Composer.tsx",
    "src/composer/store.ts",
    "src-tauri/Cargo.toml",
    "src-tauri/src/lib.rs"
].map((path) => ({ path: path.replace(/\/$/, ""), dir: path.endsWith("/") }));

/** Ignored in the made-up project, listed only with `all`. */
const FAKE_IGNORED: WorkspaceEntry[] = [
    { path: "node_modules", dir: true },
    { path: "node_modules/react", dir: true },
    { path: "node_modules/react/index.js", dir: false },
    { path: ".env", dir: false }
];

/**
 * Every file and folder under `cwd` that `.gitignore` doesn't hide (all of
 * them with `all`), shallowest first (`src-tauri/src/files.rs`).
 */
export function listFiles(cwd: string, all = false): Promise<WorkspaceEntry[]> {
    return backend("list_files", { cwd, all }, () =>
        all ? [...FAKE, ...FAKE_IGNORED] : FAKE
    );
}

/** The made-up project's text, for its text search and the editor's fake. */
export const FAKE_TEXT: Record<string, string> = {
    "README.md": `# Hive\n\nA desktop UI for driving coding-agent CLIs.\n${Array.from(
        { length: 120 },
        (_, i) => `\nLine ${i + 4} of filler.`
    ).join("")}\n\nThe end: a needle far down.\n`,
    "src/App.tsx": "export function App() {\n    return <Shell />;\n}\n",
    "src/main.tsx": 'import { App } from "./App";\n\ncreateRoot(root).render(<App />);\n',
    "src/composer/Composer.tsx": "export function Composer() {\n    // The prompt field.\n}\n"
};

/**
 * Every line under `cwd` with `query` in it (`src-tauri/src/search.rs`),
 * files by path; rejects an invalid regular expression. A newer search of
 * the same folder ends this one (rejected).
 */
export function searchText(
    cwd: string,
    query: string,
    options: TextSearchOptions,
    all: boolean
): Promise<TextSearchResult> {
    return backend("search_text", { cwd, query, options, all }, () => {
        let source = options.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        if (options.wholeWord) source = `\\b(?:${source})\\b`;
        let re: RegExp;
        try {
            re = new RegExp(source, options.caseSensitive ? "g" : "gi");
        } catch (error) {
            return Promise.reject(`Invalid regular expression: ${String(error)}`);
        }
        const files = Object.entries(FAKE_TEXT).flatMap(([path, text]) => {
            const matches = text.split("\n").flatMap((line, i) => {
                const ranges = [...line.matchAll(re)]
                    .filter((m) => m[0])
                    .map((m): [number, number] => [m.index, m.index + m[0].length]);
                return ranges.length
                    ? [{ line: i + 1, preview: line, previewOffset: 0, ranges }]
                    : [];
            });
            return matches.length ? [{ path, matches }] : [];
        });
        return { files, truncated: false };
    });
}

/** `path` is `ancestor` or inside it. */
export const containsPath = (ancestor: string, path: string) =>
    path === ancestor || path.startsWith(`${ancestor}/`);

/**
 * Renames `path` under `cwd` to `name` in the same folder; the new path. Refused when `name` is taken or isn't one name.
 */
export function renameEntry(cwd: string, path: string, name: string): Promise<string> {
    return backend("rename_entry", { cwd, path, name }, () => {
        const slash = path.lastIndexOf("/");
        const to = slash === -1 ? name : `${path.slice(0, slash)}/${name}`;
        if (!name || /[/\\:]/.test(name)) {
            return Promise.reject("Enter a single file name without path separators");
        }
        if (to !== path && FAKE.some((e) => e.path === to)) {
            return Promise.reject(`${name} already exists`);
        }
        FAKE = FAKE.map((e) =>
            containsPath(path, e.path) ? { ...e, path: to + e.path.slice(path.length) } : e
        );
        return to;
    });
}

/** Deletes `path` under `cwd` for good, a folder with everything in it. */
export function deleteEntry(cwd: string, path: string): Promise<void> {
    return backend("delete_entry", { cwd, path }, () => {
        FAKE = FAKE.filter((e) => !containsPath(path, e.path));
    });
}

/**
 * What's directly in `dir` under `cwd` ("" for `cwd` itself), folders
 * first, then by name. With `all`, ignored ones too, marked.
 */
export function listDirectory(
    cwd: string,
    dir: string,
    all: boolean
): Promise<DirectoryEntry[]> {
    return backend("list_directory", { cwd, dir, all }, () => {
        const inDir = (entry: WorkspaceEntry) =>
            entry.path.slice(0, Math.max(0, entry.path.lastIndexOf("/"))) === dir;
        const entries = [
            ...FAKE.filter(inDir).map((e) => ({ ...e, ignored: false })),
            ...(all ? FAKE_IGNORED.filter(inDir).map((e) => ({ ...e, ignored: true })) : [])
        ];
        return entries.sort(
            (a, b) =>
                Number(b.dir) - Number(a.dir) ||
                baseName(a.path).toLowerCase().localeCompare(baseName(b.path).toLowerCase())
        );
    });
}
