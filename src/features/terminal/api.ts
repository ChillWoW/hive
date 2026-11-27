import { Channel } from "@tauri-apps/api/core";
import { backend } from "@/lib/backend";
import { isTauri } from "@/lib/platform";

export type TerminalStarted = { id: number; shell: string };

export type TerminalHandlers = {
    /** Output, as the shell wrote it (UTF-8 may split across calls). */
    onData: (bytes: Uint8Array) => void;
    /** What runs in front: a program's name (`cargo`, `node`), or null while the shell itself is. */
    onProcess: (name: string | null) => void;
    /** After its last output: the exit code, or null when a signal ended it. */
    onExit: (code: number | null) => void;
};

/**
 * Starts the user's shell in `cwd` (`src-tauri/src/terminal.rs`); null or a
 * folder that's gone starts it at home.
 */
export function spawnTerminal(
    cwd: string | null,
    cols: number,
    rows: number,
    handlers: TerminalHandlers
): Promise<TerminalStarted> {
    // Channels need the app, so this can't wait for `backend` to refuse.
    if (!isTauri) return Promise.reject(new Error("No shell under plain `bun run dev`."));
    const data = new Channel<ArrayBuffer>();
    data.onmessage = (buffer) => handlers.onData(new Uint8Array(buffer));
    const process = new Channel<string | null>();
    process.onmessage = handlers.onProcess;
    const exit = new Channel<number | null>();
    exit.onmessage = handlers.onExit;
    return backend<TerminalStarted>("terminal_spawn", {
        cwd,
        cols,
        rows,
        onData: data,
        onProcess: process,
        onExit: exit
    });
}

/**
 * Follows a background task's output file (`src-tauri/src/task_output.rs`):
 * `onData` gets what's in it, then more as it's written (UTF-8 may split
 * across calls). Returns what stops it.
 */
export function watchTaskOutput(path: string, onData: (bytes: Uint8Array) => void): () => void {
    if (!isTauri) return () => {};
    let live = true;
    const data = new Channel<ArrayBuffer>();
    data.onmessage = (buffer) => {
        if (live) onData(new Uint8Array(buffer));
    };
    const watch = backend<number>("task_output_watch", { path, onData: data });
    watch.catch(() => {});
    return () => {
        live = false;
        void watch.then((id) => backend("task_output_unwatch", { id })).catch(() => {});
    };
}

/** Types `bytes` into terminal `id`; resolves once the backend has them. */
export function writeTerminal(id: number, bytes: Uint8Array): Promise<void> {
    return backend<void>("terminal_write", bytes, undefined, {
        headers: { "x-terminal-id": String(id) }
    });
}

export function resizeTerminal(id: number, cols: number, rows: number) {
    void backend("terminal_resize", { id, cols, rows }).catch(() => {});
}

/** Hangs up terminal `id`; its `onExit` still follows. */
export function killTerminal(id: number) {
    void backend("terminal_kill", { id }).catch(() => {});
}

/** What runs in terminal `id` right now, as `onProcess` reports it. */
export function foregroundProcess(id: number): Promise<string | null> {
    return backend<string | null>("terminal_foreground", { id });
}
