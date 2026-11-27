import { useEffect } from "react";
import { create } from "zustand";
import type { WorkspaceEntry } from "@/proto";
import { backend } from "@/lib/backend";
import { fuzzyScore, rankBy } from "@/lib/fuzzy";
import { baseName } from "@/lib/paths";
import { onWindowFocus } from "@/lib/windowFocus";
import { watchFiles } from "./watch";

/** How long a folder's listing is fresh. */
const FRESH_MS = 15_000;

/** A made-up project for plain `bun run dev`, where there's no backend. */
const FAKE: WorkspaceEntry[] = [
    "src/",
    "src-tauri/",
    "!node_modules/",
    "README.md",
    "package.json",
    "src/App.tsx",
    "src/main.tsx",
    "src/features/",
    "src/features/composer/",
    "src/features/composer/Composer.tsx",
    "src-tauri/src/",
    "src-tauri/src/lib.rs"
].map((mark) => {
    const path = mark.replace(/^!/, "").replace(/\/$/, "");
    return { path, dir: mark.endsWith("/"), ignored: mark.startsWith("!") };
});

/**
 * Every file and folder under `cwd` that `.gitignore` doesn't hide,
 * shallowest first; with `ignored`, also the ignored ones right inside them
 * (`src-tauri/src/files.rs`).
 */
function listFiles(cwd: string, ignored: boolean): Promise<WorkspaceEntry[]> {
    return backend("list_files", { cwd, ignored }, () => FAKE.filter((e) => ignored || !e.ignored));
}

type Listing = { at: number; entries: WorkspaceEntry[] };

type ListingsState = {
    /** Each folder's last listing, by `listingKey`; shared by every composer and the file panel. */
    listings: Record<string, Listing>;
    /** Ignored folders opened in the file panel: their entries, by root, then by path. */
    folders: Record<string, Record<string, WorkspaceEntry[]>>;
};

const useListingsStore = create<ListingsState>()(() => ({ listings: {}, folders: {} }));

/** The cache key of `cwd`'s listing, with or without its ignored entries. */
const listingKey = (cwd: string, ignored: boolean) => (ignored ? `${cwd}\0ignored` : cwd);

const pending = new Map<string, Promise<void>>();
/** Listings whose running walk may predate a change: listed once more after it. */
const stale = new Set<string>();

/** Lists `cwd` again, one listing at a time per folder; a change during one lists once more. */
function relist(cwd: string, ignored: boolean): Promise<void> {
    const key = listingKey(cwd, ignored);
    const running = pending.get(key);
    if (running) {
        stale.add(key);
        return running;
    }
    const listing = listFiles(cwd, ignored)
        .then(
            (entries) =>
                useListingsStore.setState((s) => ({
                    listings: { ...s.listings, [key]: { at: Date.now(), entries } }
                })),
            (error: unknown) => console.warn("[files] listing failed", error)
        )
        .finally(() => {
            pending.delete(key);
            if (stale.delete(key)) void relist(cwd, ignored);
        });
    pending.set(key, listing);
    return listing;
}

/**
 * Re-lists `cwd` unless its last listing is fresh (or `force`, which also
 * forgets its opened ignored folders); one listing at a time per folder.
 */
export function refreshFiles(cwd: string, { force = false, ignored = false } = {}): Promise<void> {
    const key = listingKey(cwd, ignored);
    const last = useListingsStore.getState().listings[key];
    if (!force && last && Date.now() - last.at < FRESH_MS) return Promise.resolve();
    if (force) {
        useListingsStore.setState((s) => ({ folders: { ...s.folders, [cwd]: {} } }));
        return relist(cwd, ignored);
    }
    return pending.get(key) ?? relist(cwd, ignored);
}

/**
 * `cwd`'s files and folders (with `ignored`, the ignored ones too), kept
 * current while `active`: re-listed when something under it changes on disk
 * (`watchFiles`), and, should the watch fail, whenever the last listing went
 * stale and on window focus. Undefined until the first listing arrives; the
 * last listing stays shown while a new one loads.
 */
export function useWorkspaceFiles(cwd: string, active: boolean, ignored = false): WorkspaceEntry[] | undefined {
    const entries = useListingsStore((s) => (cwd ? s.listings[listingKey(cwd, ignored)]?.entries : undefined));
    useEffect(() => {
        if (!cwd || !active) return;
        const refresh = () => void refreshFiles(cwd, { ignored });
        refresh();
        const unfocus = onWindowFocus(refresh);
        const unwatch = watchFiles(cwd, (listing) => {
            if (listing) void relist(cwd, ignored);
        });
        return () => {
            unfocus();
            unwatch();
        };
    }, [cwd, active, ignored]);
    return entries;
}

const NO_FOLDERS: Record<string, WorkspaceEntry[]> = {};

/** The ignored folders opened under `cwd`, by path. */
export const useOpenedFolders = (cwd: string) => useListingsStore((s) => s.folders[cwd] ?? NO_FOLDERS);

const loading = new Set<string>();

/** Lists what's inside the ignored folder `path` under `cwd`, once; refreshing forgets it. */
export function loadFolder(cwd: string, path: string): void {
    const key = `${cwd}\0${path}`;
    if (loading.has(key) || useListingsStore.getState().folders[cwd]?.[path]) return;
    loading.add(key);
    backend<WorkspaceEntry[]>("list_folder", { cwd, path }, () => [])
        .then(
            (entries) =>
                useListingsStore.setState((s) => ({
                    folders: { ...s.folders, [cwd]: { ...s.folders[cwd], [path]: entries } }
                })),
            (error: unknown) => console.warn("[files] listing a folder failed", error)
        )
        .finally(() => loading.delete(key));
}

/**
 * How well a path matches: a path that starts with the query (`src/comp`)
 * ahead of the rest, else by its name when that scores better, since a name
 * is what people type. Shallower first among equals.
 */
function scoreEntry(query: string, entry: WorkspaceEntry): number | null {
    const path = entry.path;
    const byPath = fuzzyScore(query, path);
    if (byPath === null) return null;
    const depth = path.split("/").length - 1;
    if (path.toLowerCase().startsWith(query.toLowerCase())) return byPath + 100 - depth;
    const byName = fuzzyScore(query, baseName(path));
    return (byName === null ? byPath : Math.max(byPath, byName + 20)) - depth * 0.5;
}

/** The best `limit` entries for `query`, best first. */
export const rankEntries = (query: string, entries: readonly WorkspaceEntry[], limit: number) =>
    rankBy(entries, (entry) => scoreEntry(query, entry), limit);
