import { useContext, useEffect, useState } from "react";
import { create } from "zustand";
import type { BackgroundTask, Message, MessagePart } from "@/proto";
import { LiveTasks } from "./context";
import { findSpawn } from "./fold";

export type SpawnPart = Extract<MessagePart, { kind: "tool" }>;

type SubagentState = {
    /** The subagent shown in the main pane: its chat, then the spawn ids from the outermost in. */
    open: { chatId: string; path: string[] } | null;
    /** Shows a spawn's thread; one opened inside another's thread goes a level deeper. */
    openSubagent: (chatId: string, id: string) => void;
    /** Back up a level: to the parent subagent, else the chat. */
    openParent: () => void;
    close: () => void;
};

export const useSubagentStore = create<SubagentState>((set) => ({
    open: null,
    openSubagent: (chatId, id) =>
        set(({ open }) => ({
            open: {
                chatId,
                path: open?.chatId === chatId && !open.path.includes(id) ? [...open.path, id] : [id]
            }
        })),
    openParent: () =>
        set(({ open }) => ({
            open: open && open.path.length > 1 ? { ...open, path: open.path.slice(0, -1) } : null
        })),
    close: () => set({ open: null })
}));

/** A spawn part anywhere in a chat's messages (nested ones included). */
export function findSpawnIn(messages: Message[], id: string): { spawn: SpawnPart; message: Message } | null {
    for (const message of messages) {
        const spawn = findSpawn(message.parts, id);
        if (spawn?.call.kind === "subagent") return { spawn, message };
    }
    return null;
}

export type SubagentPhase = "running" | "done" | "failed" | "stopped";

/**
 * Where a spawn stands. One left running in the background (`live`: the
 * session still lists its task) runs on past its turn; otherwise a turn that
 * ended under a running one left it stopped, unless its spawn call had
 * already come back (a background launch whose task has since gone).
 */
export function subagentState(part: SpawnPart, streaming: boolean, live = false): SubagentPhase {
    const raw = part.subagent ?? (part.isError ? "failed" : part.resolved ? "done" : "running");
    if (raw !== "running" || streaming || live) return raw;
    return part.resolved && !part.isError ? "done" : "stopped";
}

/** Its background task, while the session lists it. */
export function useLiveTask(id: string): BackgroundTask | undefined {
    return useContext(LiveTasks).find((t) => t.toolCallId === id);
}

/** A spawn's state and how long it ran, from the transcript and the live session. */
export function useSubagent(part: SpawnPart, streaming: boolean) {
    const task = useLiveTask(part.id);
    const state = subagentState(part, streaming, !!task);
    const elapsed = useSubagentElapsed(part.id, state === "running", task?.startedAt);
    return { state, elapsed };
}

/** What a spawn call returned, unless it was only Claude's note that a background agent started. */
export function spawnResult(part: SpawnPart): string | undefined {
    const output = part.output?.trim();
    return output && !/^async agent launched/i.test(output) ? output : undefined;
}

export const SUBAGENT_STATE: Record<SubagentPhase, { dot: string; label: string }> = {
    running: { dot: "bg-info", label: "Running" },
    done: { dot: "bg-success", label: "Completed" },
    failed: { dot: "bg-danger", label: "Failed" },
    stopped: { dot: "bg-dark-300", label: "Stopped" }
};

// When this window first saw each subagent running, and saw it end. Shared
// by its row and its view; one that ran before a reload has no time.
const started = new Map<string, number>();
const ended = new Map<string, number>();

/** How long a subagent ran (ticking while it runs), or null if its start isn't known. */
export function useSubagentElapsed(id: string, running: boolean, startedAt?: number): number | null {
    // The engine's own start time wins: it outlives a reload.
    if (startedAt !== undefined) started.set(id, startedAt);
    if (running && !started.has(id)) started.set(id, Date.now());
    if (!running && started.has(id) && !ended.has(id)) ended.set(id, Date.now());
    const [now, setNow] = useState(Date.now);
    useEffect(() => {
        if (!running) return;
        const tick = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(tick);
    }, [running]);
    const start = started.get(id);
    if (start === undefined) return null;
    return (running ? Math.max(now, start) : (ended.get(id) ?? now)) - start;
}

export function formatElapsed(ms: number): string {
    const s = Math.max(0, Math.floor(ms / 1000));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}
