import { Channel, invoke } from "@tauri-apps/api/core";
import { isTauri } from "@/lib/platform";

export type TerminalStarted = { id: number; shell: string };

/**
 * Starts the user's shell in `cwd` (`src-tauri/src/terminals.rs`). Its output
 * arrives on `onData`; `onExit` follows its last output.
 */
export function spawnTerminal(
    cwd: string | null,
    cols: number,
    rows: number,
    onData: (bytes: Uint8Array) => void,
    onExit: (code: number | null) => void
): Promise<TerminalStarted> {
    if (!isTauri) return Promise.reject(new Error("No shell under plain `bun run dev`."));
    const data = new Channel<ArrayBuffer>();
    data.onmessage = (buffer) => onData(new Uint8Array(buffer));
    const exit = new Channel<number | null>();
    exit.onmessage = onExit;
    return invoke<TerminalStarted>("terminal_spawn", {
        cwd,
        cols,
        rows,
        onData: data,
        onExit: exit
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
