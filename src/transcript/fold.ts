import type { AgentEvent, MessagePart } from "@/proto";

/**
 * Folds one streamed event into an assistant message's parts, in place
 * (call it on an immer draft). Mirrors `fold_event` in
 * `crates/proto/src/fold.rs`, which folds what gets saved; keep the two in
 * step.
 *
 * - Deltas grow the trailing text/reasoning part, or start one if the trail
 *   is something else (a tool call in between splits a text block).
 * - A `toolCall` with a known id refreshes that part in place, which is how a
 *   live todo list updates; `toolResult` resolves it.
 * - Events that aren't transcript content (usage, commands, …) are ignored
 *   here and read by whoever needs them.
 */
export function foldEvent(parts: MessagePart[], event: AgentEvent) {
    switch (event.type) {
        case "sessionStarted":
            parts.length = 0;
            return;

        case "textDelta":
        case "reasoningDelta": {
            if (!event.text) return;
            const kind = event.type === "textDelta" ? "text" : "reasoning";
            const last = parts.at(-1);
            if (last?.kind === kind) {
                last.text += event.text;
            } else {
                parts.push({
                    kind,
                    id: `${kind[0]}${parts.length}`,
                    text: event.text
                });
            }
            return;
        }

        case "toolCall": {
            const existing = findTool(parts, event.id);
            if (existing) {
                existing.call = event.call;
            } else {
                parts.push({
                    kind: "tool",
                    id: event.id,
                    call: event.call,
                    resolved: false,
                    isError: false,
                    subagent:
                        event.call.kind === "subagent" ? "running" : undefined
                });
            }
            return;
        }

        case "toolResult": {
            const tool = findTool(parts, event.id);
            if (!tool) return;
            tool.resolved = true;
            tool.isError = event.isError;
            tool.output = event.output;
            tool.diff = event.diff;
            return;
        }

        case "inputRequested": {
            const id = `in-${event.requestId}`;
            if (parts.some((p) => p.id === id)) return;
            parts.push({
                kind: "input",
                id,
                requestId: event.requestId,
                questions: event.questions,
                resolved: false
            });
            return;
        }

        case "inputResolved":
            for (const p of parts) {
                if (p.kind === "input" && p.requestId === event.requestId) {
                    p.resolved = true;
                }
            }
            return;

        // Updates the one running, else starts one.
        case "compaction": {
            const running = runningCompaction(parts);
            if (running) {
                running.status = event.status;
                running.auto = running.auto || event.auto;
                if (event.beforeTokens !== undefined) running.beforeTokens = event.beforeTokens;
                if (event.afterTokens !== undefined) running.afterTokens = event.afterTokens;
                if (event.error !== undefined) running.error = event.error;
            } else {
                parts.push({
                    kind: "compaction",
                    id: `c${parts.length}`,
                    status: event.status,
                    auto: event.auto,
                    beforeTokens: event.beforeTokens,
                    afterTokens: event.afterTokens,
                    error: event.error
                });
            }
            return;
        }

        case "error":
            parts.push({
                kind: "error",
                id: `e${parts.length}`,
                message: event.message
            });
            return;

        case "done": {
            // A compaction the turn never reported the end of ends with it.
            const running = runningCompaction(parts);
            if (running) {
                running.status =
                    event.status === "completed"
                        ? "completed"
                        : event.status === "interrupted"
                          ? "stopped"
                          : "failed";
            }
            if (event.error) {
                parts.push({
                    kind: "error",
                    id: `e${parts.length}`,
                    message: event.error
                });
            }
            return;
        }

        // The parent transcript keeps only the spawn chip; this tracks its
        // lifecycle. The subagent's own content would fold into its own view.
        case "subagent": {
            const tool = findTool(parts, event.parentToolId);
            if (!tool || tool.call.kind !== "subagent") return;
            const inner = event.event;
            if (inner.type === "done") {
                tool.subagent = inner.status === "errored" ? "failed" : "done";
            } else if (tool.subagent !== "done" && tool.subagent !== "failed") {
                tool.subagent = "running";
            }
            return;
        }

        case "backgroundTurn":
            parts.push({ kind: "wake", id: `w${parts.length}`, finished: event.finished });
            return;

        case "contextUsage":
        case "usage":
        case "availableCommands":
        case "backgroundTasks":
        case "goalChanged":
            return;

        default:
            // A new AgentEvent variant in Rust fails the build here until
            // it's handled.
            event satisfies never;
    }
}

function runningCompaction(parts: MessagePart[]) {
    const part = parts.findLast((p) => p.kind === "compaction" && p.status === "running");
    return part?.kind === "compaction" ? part : undefined;
}

function findTool(parts: MessagePart[], id: string) {
    const part = parts.find((p) => p.kind === "tool" && p.id === id);
    return part?.kind === "tool" ? part : undefined;
}
