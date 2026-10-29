import { create } from "zustand";
import type { DirectoryEntry } from "@/proto";
import { listDirectory } from "./api";

/** A folder's last listing in the file panel; `error` when the last try failed. */
export type DirListing = { entries?: DirectoryEntry[]; error?: string };

/**
 * Each listed folder of the file panel's tree, as zeron loads it: one folder
 * at a time, when it's first shown expanded. Keyed by `dirKey`.
 */
export const useTreeStore = create<{ dirs: Record<string, DirListing> }>()(() => ({
    dirs: {}
}));

/** `dir` ("" for the folder itself) under `cwd`, with or without ignored files. */
export const dirKey = (cwd: string, all: boolean, dir: string) =>
    `${all ? 1 : 0}\0${cwd}\0${dir}`;

const inflight = new Map<string, Promise<void>>();

/** Lists `dir`; the last listing stays shown meanwhile. */
export function loadDir(cwd: string, all: boolean, dir: string): Promise<void> {
    const key = dirKey(cwd, all, dir);
    let pending = inflight.get(key);
    if (!pending) {
        const save = (listing: DirListing) =>
            useTreeStore.setState((s) => ({ dirs: { ...s.dirs, [key]: listing } }));
        pending = listDirectory(cwd, dir, all)
            .then(
                (entries) => save({ entries }),
                (error: unknown) =>
                    save({ error: typeof error === "string" ? error : String(error) })
            )
            .finally(() => inflight.delete(key));
        inflight.set(key, pending);
    }
    return pending;
}

/** Re-lists every folder of `cwd`'s tree listed so far (it may have changed). */
export function reloadTree(cwd: string, all: boolean) {
    const prefix = dirKey(cwd, all, "");
    for (const key of Object.keys(useTreeStore.getState().dirs)) {
        if (key.startsWith(prefix)) void loadDir(cwd, all, key.slice(prefix.length));
    }
}

/** The last part of a `/`-separated path. */
export const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);
