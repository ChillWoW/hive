import { use } from "react";
import type { Message, MessagePart } from "@/proto";
import { useNow } from "@/lib/time";
import { LiveTasks } from "./context";
import type { ToolPart } from "./tools";

export type SubagentPhase = "running" | "done" | "failed" | "stopped";

export const SUBAGENT_STATE: Record<SubagentPhase, { dot: string; label: string }> = {
    running: { dot: "bg-info", label: "Running" },
    done: { dot: "bg-success", label: "Completed" },
    failed: { dot: "bg-danger", label: "Failed" },
    stopped: { dot: "bg-muted/60", label: "Stopped" }
};

/**
 * Where a spawn stands. One left running in the background (`live`: the
 * session still lists its task) runs on past its turn; otherwise a turn that
 * ended under a running one left it stopped, unless its spawn call had
 * already come back (a background launch whose task has since gone).
 */
export function subagentState(part: ToolPart, streaming: boolean, live: boolean): SubagentPhase {
    const raw = part.subagent ?? (part.isError ? "failed" : part.resolved ? "done" : "running");
    if (raw !== "running" || streaming || live) return raw;
    return part.resolved && !part.isError ? "done" : "stopped";
}

/** A spawn's state and how long it ran (ticking while it runs; null when unknown). */
export function useSubagent(part: ToolPart, streaming: boolean) {
    const live = use(LiveTasks).some((t) => t.toolCallId === part.id);
    const state = subagentState(part, streaming, live);
    const now = useNow(1000, state === "running");
    const start = part.startedAt;
    let elapsed: number | null = null;
    if (start !== undefined) {
        if (state === "running") elapsed = Math.max(now, start) - start;
        else if (part.endedAt !== undefined) elapsed = Math.max(part.endedAt, start) - start;
    }
    return { state, elapsed };
}

/** What a subagent is called: its task's description, else its agent type. */
export function subagentName(part: ToolPart): string {
    return (part.call.kind === "subagent" && (part.call.description || part.call.agent)) || "Subagent";
}

/** A subagent spawn by its call id, at this level or in a spawn's thread. */
function findSpawn(parts: MessagePart[], id: string): ToolPart | null {
    for (const part of parts) {
        if (part.kind !== "tool" || part.call.kind !== "subagent") continue;
        if (part.id === id) return part;
        const inner = part.thread && findSpawn(part.thread, id);
        if (inner) return inner;
    }
    return null;
}

/** A spawn anywhere in a chat's messages (nested ones included), with the message it's in. */
export function findSpawnIn(messages: Message[], id: string): { spawn: ToolPart; message: Message } | null {
    for (const message of messages) {
        const spawn = findSpawn(message.parts, id);
        if (spawn) return { spawn, message };
    }
    return null;
}

/** What a spawn call returned, unless it was only Claude's note that a background agent started. */
export function spawnResult(part: ToolPart): string | undefined {
    const output = part.output?.trim();
    return output && !/^async agent launched/i.test(output) ? output : undefined;
}

/** A line as plain text: markdown links, emphasis and list markers dropped. */
function plainLine(line: string): string {
    return line
        .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
        .replace(/[`*_#>]/g, "")
        .replace(/^\s*[-+]\s+/, "")
        .trim();
}

/** What a subagent last said: the last line of its latest text. */
export function progressLine(thread: MessagePart[] | undefined): string | null {
    const text = thread?.findLast((p) => p.kind === "text");
    return text?.kind === "text" ? (text.text.split("\n").map(plainLine).findLast(Boolean) ?? null) : null;
}

/** The first line of a subagent's result, as plain text. */
export function resultLine(output: string | undefined): string | null {
    return output?.split("\n").map(plainLine).find(Boolean) ?? null;
}
