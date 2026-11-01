import { useContext } from "react";
import type { Message, MessagePart } from "@/proto";
import { LiveTasks } from "./context";
import { findSpawn, type ToolPart } from "./fold";
import { useNow } from "@/lib/time";

export type SpawnPart = ToolPart;

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

/** A spawn's state and how long it ran, from the transcript and the live session. */
export function useSubagent(part: SpawnPart, streaming: boolean) {
    // Its background task, while the session lists it.
    const task = useContext(LiveTasks).find((t) => t.toolCallId === part.id);
    const state = subagentState(part, streaming, !!task);
    const elapsed = useSubagentElapsed(part, state === "running", task?.startedAt);
    return { state, elapsed };
}

/** What a subagent is called: its task's description, else its agent type. */
export function subagentName(part: SpawnPart): string {
    return (part.call.kind === "subagent" && (part.call.description || part.call.agent)) || "Subagent";
}

/** What a spawn call returned, unless it was only Claude's note that a background agent started. */
export function spawnResult(part: SpawnPart): string | undefined {
    const output = part.output?.trim();
    return output && !/^async agent launched/i.test(output) ? output : undefined;
}

/** A line as plain text: markdown links, emphasis and list markers dropped. */
export function plainLine(line: string): string {
    return line
        .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
        .replace(/[`*_#>]/g, "")
        .replace(/^\s*[-+]\s+/, "")
        .trim();
}

/** What a running subagent last said: the last line of its latest text. */
export function progressLine(thread: MessagePart[] | undefined): string | null {
    const text = thread?.findLast((p) => p.kind === "text");
    return text?.kind === "text" ? (text.text.split("\n").map(plainLine).findLast(Boolean) ?? null) : null;
}

export const SUBAGENT_STATE: Record<SubagentPhase, { dot: string; label: string }> = {
    running: { dot: "bg-info", label: "Running" },
    done: { dot: "bg-success", label: "Completed" },
    failed: { dot: "bg-danger", label: "Failed" },
    stopped: { dot: "bg-dark-300", label: "Stopped" }
};

// When this window saw a subagent start and end: a fallback for spawns
// saved before they carried `startedAt`/`endedAt`.
const seenStart = new Map<string, number>();
const seenEnd = new Map<string, number>();

/**
 * How long a subagent ran, ticking while it runs: from its spawn's saved
 * stamps, else its background task's start, else what this window saw;
 * null when its start isn't known.
 */
function useSubagentElapsed(part: SpawnPart, running: boolean, taskStartedAt?: number): number | null {
    const id = part.id;
    if (running && !seenStart.has(id)) seenStart.set(id, Date.now());
    if (!running && seenStart.has(id) && !seenEnd.has(id)) seenEnd.set(id, Date.now());
    const now = useNow(running);
    const start = part.startedAt ?? taskStartedAt ?? seenStart.get(id);
    if (start === undefined) return null;
    if (running) return Math.max(now, start) - start;
    const end = part.endedAt ?? seenEnd.get(id);
    return end === undefined ? null : Math.max(end, start) - start;
}
