import { create } from "zustand";
import type { DirectoryEntry } from "@/proto";
import { listDirectory } from "./api";

/** A folder's last listing in the file panel; `error` when the last try failed. */
export type DirListing = { entries?: DirectoryEntry[]; error?: string };

/**
 * Each listed folder of the file panel's tree, loaded one folder at a time, when it's first shown expanded. Keyed by `dirKey`.
 */
export const useTreeStore = create<{ dirs: Record<string, DirListing> }>()(() => ({
    dirs: {}
}));

/** `dir` ("" for the folder itself) under `cwd`, with or without ignored files. */
export const dirKey = (cwd: string, all: boolean, dir: string) =>
    `${all ? 1 : 0}\0${cwd}\0${dir}`;

const inflight = new Map<string, Promise<void>>();
/** Asked again while a listing ran: it may predate the change, so list once more. */
const again = new Map<string, Promise<void>>();

/**
 * Lists `dir`; the last listing stays shown meanwhile. With `fresh`, one
 * already running is followed by another.
 */
export function loadDir(cwd: string, all: boolean, dir: string, fresh = false): Promise<void> {
    const key = dirKey(cwd, all, dir);
    let pending = inflight.get(key);
    if (pending && fresh) {
        let next = again.get(key);
        if (!next) {
            next = pending.then(() => {
                again.delete(key);
                return loadDir(cwd, all, dir);
            });
            again.set(key, next);
        }
        return next;
    }
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
export function reloadTree(cwd: string, all: boolean, fresh = false) {
    const prefix = dirKey(cwd, all, "");
    for (const key of Object.keys(useTreeStore.getState().dirs)) {
        if (key.startsWith(prefix)) void loadDir(cwd, all, key.slice(prefix.length), fresh);
    }
}

/** Re-lists those of `dirs` (under `cwd`) the tree has listed so far. */
export function reloadDirs(cwd: string, all: boolean, dirs: string[]) {
    const listed = useTreeStore.getState().dirs;
    for (const dir of dirs) {
        if (dirKey(cwd, all, dir) in listed) void loadDir(cwd, all, dir, true);
    }
}

/** The last part of a `/`-separated path. */
export const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);
