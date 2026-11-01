import { create } from "zustand";
import { errorMessage } from "@/lib/errors";
import { singleFlight } from "@/lib/singleFlight";
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

const listings = singleFlight<string>();

/**
 * Lists `dir`; the last listing stays shown meanwhile. With `fresh`, one
 * already running is followed by another.
 */
export function loadDir(cwd: string, all: boolean, dir: string, fresh = false): Promise<void> {
    const key = dirKey(cwd, all, dir);
    const save = (listing: DirListing) =>
        useTreeStore.setState((s) => ({ dirs: { ...s.dirs, [key]: listing } }));
    return listings(
        key,
        () =>
            listDirectory(cwd, dir, all).then(
                (entries) => save({ entries }),
                (error: unknown) => save({ error: errorMessage(error) })
            ),
        fresh
    );
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
