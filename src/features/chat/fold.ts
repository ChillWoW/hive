import type { AgentEvent, CompactionStatus, MessagePart } from "@/proto";

export type ToolPart = Extract<MessagePart, { kind: "tool" }>;
export type InputPart = Extract<MessagePart, { kind: "input" }>;
type CompactionPart = Extract<MessagePart, { kind: "compaction" }>;

/**
 * One streamed event folded into an assistant message's parts. Mirrors
 * `fold_event` in `crates/proto/src/fold.rs`; keep the two in step.
 *
 * Immutable: returns a new list, with only the parts the event touched
 * replaced, so untouched parts keep their identity (and anything cached
 * on them).
 *
 * - Deltas grow the trailing text/reasoning part, or start one if the trail
 *   is something else (a tool call in between splits a text block).
 * - A `toolCall` with a known id refreshes that part in place, which is how a
 *   live todo list updates; `toolResult` resolves it.
 * - A subagent's events fold into its spawn part's `thread`.
 * - `done` settles what the turn left open: a running compaction, and
 *   questions nothing can answer any more.
 */
export function foldEvent(parts: MessagePart[], event: AgentEvent): MessagePart[] {
    switch (event.type) {
        case "textDelta":
        case "reasoningDelta": {
            if (!event.text) return parts;
            const kind = event.type === "textDelta" ? "text" : "reasoning";
            const last = parts.at(-1);
            if (last?.kind === kind) {
                return [...parts.slice(0, -1), { ...last, text: last.text + event.text }];
            }
            return [...parts, { kind, id: `${kind[0]}${parts.length}`, text: event.text }];
        }

        case "toolCall": {
            const index = toolIndex(parts, event.id);
            if (index !== -1) {
                return replace(parts, index, { ...(parts[index] as ToolPart), call: event.call });
            }
            const part: ToolPart = { kind: "tool", id: event.id, call: event.call, resolved: false, isError: false };
            if (event.call.kind === "subagent") part.subagent = "running";
            return [...parts, part];
        }

        case "toolResult": {
            const index = toolIndex(parts, event.id);
            if (index === -1) return parts;
            return replace(parts, index, {
                ...(parts[index] as ToolPart),
                resolved: true,
                isError: event.isError,
                output: event.output
            });
        }

        case "inputRequested": {
            const id = `in-${event.requestId}`;
            if (parts.some((p) => p.id === id)) return parts;
            return [...parts, { kind: "input", id, requestId: event.requestId, request: event.request, resolved: false }];
        }

        case "inputResolved":
            return parts.map((p) =>
                p.kind === "input" && p.requestId === event.requestId
                    ? { ...p, resolved: true, response: event.response }
                    : p
            );

        case "compaction": {
            const index = runningCompaction(parts);
            if (index !== -1) {
                const running = parts[index] as CompactionPart;
                return replace(parts, index, {
                    ...running,
                    status: event.status,
                    auto: running.auto || event.auto,
                    beforeTokens: event.beforeTokens ?? running.beforeTokens,
                    afterTokens: event.afterTokens ?? running.afterTokens,
                    error: event.error ?? running.error
                });
            }
            return [
                ...parts,
                {
                    kind: "compaction",
                    id: `c${parts.length}`,
                    status: event.status,
                    auto: event.auto,
                    beforeTokens: event.beforeTokens,
                    afterTokens: event.afterTokens,
                    error: event.error
                }
            ];
        }

        case "backgroundTurn":
            return [...parts, { kind: "wake", id: `w${parts.length}`, finished: event.finished }];

        case "subagent":
            return foldIntoSpawn(parts, event.parentToolId, event.event) ?? parts;

        case "error":
            return [...parts, { kind: "error", id: `e${parts.length}`, message: event.message }];

        case "done": {
            const ended: Record<string, CompactionStatus> = {
                completed: "completed",
                interrupted: "stopped",
                errored: "failed"
            };
            let next = parts;
            const index = runningCompaction(parts);
            if (index !== -1) {
                next = replace(next, index, { ...(parts[index] as CompactionPart), status: ended[event.status]! });
            }
            if (next.some((p) => p.kind === "input" && !p.resolved)) {
                next = next.map((p) => (p.kind === "input" && !p.resolved ? { ...p, resolved: true } : p));
            }
            return next;
        }

        case "sessionStarted":
        case "contextUsage":
        case "usage":
        case "availableCommands":
        case "backgroundTasks":
            return parts;

        default:
            // A new AgentEvent variant in Rust fails the build here until
            // it's handled.
            event satisfies never;
            return parts;
    }
}

/**
 * `parts` with `event` folded into the thread of the spawn `id` (nested
 * spawns included); undefined when no spawn has that id.
 */
function foldIntoSpawn(parts: MessagePart[], id: string, event: AgentEvent): MessagePart[] | undefined {
    for (let i = 0; i < parts.length; i++) {
        const part = parts[i]!;
        if (part.kind !== "tool") continue;
        if (part.id === id && part.call.kind === "subagent") {
            const thread = foldEvent(part.thread ?? [], event);
            let subagent = part.subagent;
            if (event.type === "done") subagent = event.status === "errored" ? "failed" : "done";
            else if (event.type !== "subagent" && !subagent) subagent = "running";
            return replace(parts, i, { ...part, thread, subagent });
        }
        if (part.thread?.length) {
            const thread = foldIntoSpawn(part.thread, id, event);
            if (thread) return replace(parts, i, { ...part, thread });
        }
    }
    return undefined;
}

function toolIndex(parts: MessagePart[], id: string) {
    return parts.findIndex((p) => p.kind === "tool" && p.id === id);
}

function runningCompaction(parts: MessagePart[]) {
    return parts.findLastIndex((p) => p.kind === "compaction" && p.status === "running");
}

function replace(parts: MessagePart[], index: number, part: MessagePart): MessagePart[] {
    const next = parts.slice();
    next[index] = part;
    return next;
}

/** The question or approval the reply waits on, if any: the latest unanswered. */
export function pendingInput(parts: MessagePart[]): InputPart | undefined {
    return parts.findLast((p): p is InputPart => p.kind === "input" && !p.resolved);
}

/**
 * Stamps when a subagent was spawned and when it finished on its spawn
 * part, `now` being when `event` came. Mirrors `stamp_event` in
 * `crates/proto/src/fold.rs`; call it after `foldEvent` with the same event.
 */
export function stampEvent(parts: MessagePart[], event: AgentEvent, now: number): MessagePart[] {
    if (event.type === "toolCall" && event.call.kind === "subagent") {
        return updateSpawn(parts, event.id, (p) => (p.startedAt === undefined ? { ...p, startedAt: now } : p)) ?? parts;
    }
    if (event.type !== "subagent") return parts;
    if (event.event.type === "done") {
        return updateSpawn(parts, event.parentToolId, (p) => (p.endedAt === undefined ? { ...p, endedAt: now } : p)) ?? parts;
    }
    return stampEvent(parts, event.event, now);
}

/** `parts` with the spawn `id` (nested ones included) changed by `change`; undefined when there's none. */
function updateSpawn(parts: MessagePart[], id: string, change: (part: ToolPart) => ToolPart): MessagePart[] | undefined {
    for (let i = 0; i < parts.length; i++) {
        const part = parts[i]!;
        if (part.kind !== "tool") continue;
        if (part.id === id && part.call.kind === "subagent") {
            const next = change(part);
            return next === part ? parts : replace(parts, i, next);
        }
        if (part.thread?.length) {
            const thread = updateSpawn(part.thread, id, change);
            if (thread) return thread === part.thread ? parts : replace(parts, i, { ...part, thread });
        }
    }
    return undefined;
}
