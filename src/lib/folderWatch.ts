import { Channel, invoke } from "@tauri-apps/api/core";
import { useEffect, useRef } from "react";
import { isTauri } from "@/lib/platform";

/** What changed under a watched folder since the last batch (`src-tauri/src/watch.rs`). */
export type FolderChange = {
    /** Changed paths `.gitignore` doesn't hide (in a flat watch, every one), relative, `/`-separated. */
    paths: string[];
    /** Folders ("" for the watched one) where an entry appeared, went or was renamed, ignored ones too. */
    dirs: string[];
    /** Too many folders for `dirs`: any listing may be stale. */
    dirsOverflow: boolean;
    /** An entry `.gitignore` doesn't hide appeared, went or was renamed. */
    entries: boolean;
    /** Something ignored changed. */
    ignored: boolean;
    /** HEAD, a ref or the index moved. */
    git: boolean;
    /** Too much to list, or events were lost: anything may have changed. */
    overflow: boolean;
};

type Listener = (change: FolderChange) => void;

type Watch = { listeners: Set<Listener>; id?: Promise<number | null> };

/** One backend watch per folder and mode, shared by its listeners. */
const watches = new Map<string, Watch>();

const keyOf = (cwd: string, recursive: boolean) => `${recursive ? "r" : "f"}\0${cwd}`;

/**
 * Calls `listener` with each batch of changes under `cwd` (only what's
 * directly in it with `recursive` false) and in its checkout's git dirs.
 * Returns the unsubscribe. Nothing under plain `bun run dev`.
 */
export function watchFolder(cwd: string, listener: Listener, recursive = true): () => void {
    if (!isTauri) return () => {};
    const key = keyOf(cwd, recursive);
    let watch = watches.get(key);
    if (!watch) {
        const created: Watch = { listeners: new Set() };
        const channel = new Channel<FolderChange>();
        channel.onmessage = (change) => {
            for (const l of created.listeners) l(change);
        };
        created.id = invoke<number>("watch_folder", { cwd, recursive, onChange: channel }).catch(
            (error: unknown) => {
                console.warn("[watch] can't watch", cwd, error);
                return null;
            }
        );
        watches.set(key, created);
        watch = created;
    }
    const current = watch;
    current.listeners.add(listener);
    return () => {
        current.listeners.delete(listener);
        if (current.listeners.size > 0 || watches.get(key) !== current) return;
        watches.delete(key);
        void current.id?.then((id) => {
            if (id !== null) void invoke("unwatch_folder", { id });
        });
    };
}

/** `watchFolder` while mounted with a folder; `onChange` may change freely. */
export function useFolderWatch(
    cwd: string | null | undefined,
    onChange: Listener,
    recursive = true
) {
    const handler = useRef(onChange);
    handler.current = onChange;
    useEffect(() => {
        if (!cwd) return;
        return watchFolder(cwd, (change) => handler.current(change), recursive);
    }, [cwd, recursive]);
}

/** Anything the working tree's state (diff, status) may have moved with. */
export const touchesTree = (c: FolderChange) => c.paths.length > 0 || c.git || c.overflow;
