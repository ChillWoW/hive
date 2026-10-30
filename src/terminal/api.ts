import { Channel, invoke } from "@tauri-apps/api/core";
import { isTauri } from "@/lib/platform";

export type TerminalStarted = { id: number; shell: string };

/**
 * Starts the user's shell in `cwd` (`src-tauri/src/terminals.rs`). Its output
 * arrives on `onData`; `onExit` follows its last output. `onProcess` gets
 * what runs in it whenever that changes: a program's name (`cargo`, `node`),
 * or null while the shell itself is in front.
 */
export function spawnTerminal(
    cwd: string | null,
    cols: number,
    rows: number,
    onData: (bytes: Uint8Array) => void,
    onExit: (code: number | null) => void,
    onProcess: (name: string | null) => void
): Promise<TerminalStarted> {
    if (!isTauri) return Promise.reject(new Error("No shell under plain `bun run dev`."));
    const data = new Channel<ArrayBuffer>();
    data.onmessage = (buffer) => onData(new Uint8Array(buffer));
    const exit = new Channel<number | null>();
    exit.onmessage = onExit;
    const process = new Channel<string | null>();
    process.onmessage = onProcess;
    return invoke<TerminalStarted>("terminal_spawn", {
        cwd,
        cols,
        rows,
        onData: data,
        onExit: exit,
        onProcess: process
    });
}

export function writeTerminal(id: number, bytes: Uint8Array) {
    void invoke("terminal_write", { id, data: Array.from(bytes) });
}

export function resizeTerminal(id: number, cols: number, rows: number) {
    void invoke("terminal_resize", { id, cols, rows }).catch(() => {});
}

export function killTerminal(id: number) {
    void invoke("terminal_kill", { id });
}

/** What runs in terminal `id` right now, as `onProcess` reports it. */
export function foregroundProcess(id: number): Promise<string | null> {
    return invoke<string | null>("terminal_foreground", { id });
}
