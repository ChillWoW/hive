import { useEffect } from "react";
import { create } from "zustand";
import { useFolderWatch } from "@/lib/folderWatch";
import type { WorkspaceEntry } from "@/proto";
import { listFiles } from "./api";

/** How long a folder's listing is fresh. */
const FRESH_MS = 15_000;

type Listing = { at: number; entries: WorkspaceEntry[] };

/**
 * Each folder's last listing (and, apart, its listing with ignored files),
 * shared by every composer and file panel showing it.
 */
const useFilesStore = create<{ listings: Record<string, Listing> }>()(() => ({
    listings: {}
}));

const keyOf = (cwd: string, all: boolean) => (all ? `all\0${cwd}` : cwd);

const inflight = new Map<string, Promise<void>>();
/** Forced while a listing ran: it may predate the change, so list once more. */
const again = new Map<string, Promise<void>>();

/** Re-lists `cwd` unless its last listing is fresh (or `force`). */
export function refreshFiles(cwd: string, all = false, force = false): Promise<void> {
    const key = keyOf(cwd, all);
    const last = useFilesStore.getState().listings[key];
    if (!force && last && Date.now() - last.at < FRESH_MS) return Promise.resolve();
    const running = inflight.get(key);
    if (running) {
        if (!force) return running;
        let next = again.get(key);
        if (!next) {
            next = running.then(() => {
                again.delete(key);
                return refreshFiles(cwd, all, true);
            });
            again.set(key, next);
        }
        return next;
    }
    const pending = listFiles(cwd, all)
        .then(
            (entries) =>
                useFilesStore.setState((s) => ({
                    listings: { ...s.listings, [key]: { at: Date.now(), entries } }
                })),
            (error: unknown) => console.warn("[files] listing failed", error)
        )
        .finally(() => inflight.delete(key));
    inflight.set(key, pending);
    return pending;
}

/**
 * `cwd`'s files and folders (ignored ones too with `all`), re-listed while
 * `active` when an entry appears, goes or is renamed under it (a folder
 * watch), whenever the last listing went stale and on window focus;
 * undefined until the first listing arrives. The last listing stays shown
 * while a new one loads.
 */
export function useWorkspaceFiles(
    cwd: string | null | undefined,
    active: boolean,
    all = false
): WorkspaceEntry[] | undefined {
    const entries = useFilesStore((s) =>
        cwd ? s.listings[keyOf(cwd, all)]?.entries : undefined
    );

    useEffect(() => {
        if (!cwd || !active) return;
        const refresh = () => void refreshFiles(cwd, all);
        refresh();
        window.addEventListener("focus", refresh);
        return () => window.removeEventListener("focus", refresh);
    }, [cwd, active, all]);

    useFolderWatch(active ? cwd : null, (change) => {
        const listed =
            change.entries || change.overflow || (all && (change.dirs.length > 0 || change.dirsOverflow));
        if (cwd && listed) void refreshFiles(cwd, all, true);
    });

    return entries;
}
