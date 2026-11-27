import { Channel } from "@tauri-apps/api/core";
import { backend } from "@/lib/backend";
import { isTauri } from "@/lib/platform";

/**
 * Hears of each burst of changes under a folder: `listing` when files or
 * folders came, went or moved, false when only a file's text changed.
 */
type Listener = (listing: boolean) => void;

type Watch = { listeners: Set<Listener>; stop: () => void };

const watches = new Map<string, Watch>();

/** Starts the backend's watch of `cwd` (`src-tauri/src/file_watch.rs`); returns what stops it. */
function start(cwd: string, listeners: Set<Listener>): () => void {
    if (!isTauri) return () => {};
    let live = true;
    const changes = new Channel<boolean>();
    changes.onmessage = (listing) => {
        if (live) for (const listener of [...listeners]) listener(listing);
    };
    const watch = backend<number>("files_watch", { cwd, onChange: changes });
    watch.catch((error: unknown) => console.warn("[files] watching failed", error));
    return () => {
        live = false;
        void watch.then((id) => backend("files_unwatch", { id })).catch(() => {});
    };
}

/**
 * Calls `listener` when something under `cwd` changes on disk, what
 * `.gitignore` hides aside. A folder is watched once however many listen,
 * until the last one stops. Returns what stops this one.
 */
export function watchFiles(cwd: string, listener: Listener): () => void {
    let watch = watches.get(cwd);
    if (!watch) {
        const listeners = new Set<Listener>();
        watch = { listeners, stop: start(cwd, listeners) };
        watches.set(cwd, watch);
    }
    const { listeners, stop } = watch;
    listeners.add(listener);
    return () => {
        if (!listeners.delete(listener) || listeners.size > 0) return;
        if (watches.get(cwd) === watch) watches.delete(cwd);
        stop();
    };
}
