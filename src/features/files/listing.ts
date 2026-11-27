import { useEffect } from "react";
import { create } from "zustand";
import type { WorkspaceEntry } from "@/proto";
import { backend } from "@/lib/backend";
import { fuzzyScore, rankBy } from "@/lib/fuzzy";
import { baseName } from "@/lib/paths";
import { onWindowFocus } from "@/lib/windowFocus";

/** How long a folder's listing is fresh. */
const FRESH_MS = 15_000;

/** A made-up project for plain `bun run dev`, where there's no backend. */
const FAKE: WorkspaceEntry[] = [
    "src/",
    "src-tauri/",
    "README.md",
    "package.json",
    "src/App.tsx",
    "src/main.tsx",
    "src/features/",
    "src/features/composer/",
    "src/features/composer/Composer.tsx",
    "src-tauri/src/",
    "src-tauri/src/lib.rs"
].map((path) => ({ path: path.replace(/\/$/, ""), dir: path.endsWith("/") }));

/** Every file and folder under `cwd` that `.gitignore` doesn't hide, shallowest first (`src-tauri/src/files.rs`). */
function listFiles(cwd: string): Promise<WorkspaceEntry[]> {
    return backend("list_files", { cwd }, () => FAKE);
}

type Listing = { at: number; entries: WorkspaceEntry[] };

/** Each folder's last listing, shared by every composer and the file panel. */
const useListingsStore = create<{ listings: Record<string, Listing> }>()(() => ({ listings: {} }));

const pending = new Map<string, Promise<void>>();

/**
 * Re-lists `cwd` unless its last listing is fresh (or `force`); one listing
 * at a time per folder.
 */
export function refreshFiles(cwd: string, force = false): Promise<void> {
    const last = useListingsStore.getState().listings[cwd];
    if (!force && last && Date.now() - last.at < FRESH_MS) return Promise.resolve();
    let listing = pending.get(cwd);
    if (!listing) {
        listing = listFiles(cwd)
            .then(
                (entries) =>
                    useListingsStore.setState((s) => ({
                        listings: { ...s.listings, [cwd]: { at: Date.now(), entries } }
                    })),
                (error: unknown) => console.warn("[files] listing failed", error)
            )
            .finally(() => pending.delete(cwd));
        pending.set(cwd, listing);
    }
    return listing;
}

/**
 * `cwd`'s files and folders, re-listed while `active` whenever the last
 * listing went stale and on window focus; undefined until the first listing
 * arrives. The last listing stays shown while a new one loads.
 */
export function useWorkspaceFiles(cwd: string, active: boolean): WorkspaceEntry[] | undefined {
    const entries = useListingsStore((s) => (cwd ? s.listings[cwd]?.entries : undefined));
    useEffect(() => {
        if (!cwd || !active) return;
        const refresh = () => void refreshFiles(cwd);
        refresh();
        return onWindowFocus(refresh);
    }, [cwd, active]);
    return entries;
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
