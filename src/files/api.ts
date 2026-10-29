import { invoke } from "@tauri-apps/api/core";
import type { DirectoryEntry, WorkspaceEntry } from "@/proto";
import { isTauri } from "@/lib/platform";

/** A made-up project for plain `bun run dev`, where there's no backend. */
const FAKE: WorkspaceEntry[] = [
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
    if (!isTauri) return Promise.resolve(all ? [...FAKE, ...FAKE_IGNORED] : FAKE);
    return invoke<WorkspaceEntry[]>("list_files", { cwd, all });
}

const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/**
 * What's directly in `dir` under `cwd` ("" for `cwd` itself), folders
 * first, then by name. With `all`, ignored ones too, marked.
 */
export function listDirectory(
    cwd: string,
    dir: string,
    all: boolean
): Promise<DirectoryEntry[]> {
    if (isTauri) return invoke<DirectoryEntry[]>("list_directory", { cwd, dir, all });
    const inDir = (entry: WorkspaceEntry) =>
        entry.path.slice(0, Math.max(0, entry.path.lastIndexOf("/"))) === dir;
    const entries = [
        ...FAKE.filter(inDir).map((e) => ({ ...e, ignored: false })),
        ...(all ? FAKE_IGNORED.filter(inDir).map((e) => ({ ...e, ignored: true })) : [])
    ];
    return Promise.resolve(
        entries.sort(
            (a, b) =>
                Number(b.dir) - Number(a.dir) ||
                nameOf(a.path).toLowerCase().localeCompare(nameOf(b.path).toLowerCase())
        )
    );
}
