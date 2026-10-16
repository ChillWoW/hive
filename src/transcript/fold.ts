import type { AgentEvent, MessagePart } from "@/proto";

/**
 * Folds one streamed event into an assistant message's parts, in place
 * (call it on an immer draft).
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

        case "error":
            parts.push({
                kind: "error",
                id: `e${parts.length}`,
                message: event.message
            });
            return;

        case "done":
            if (event.error) {
                parts.push({
                    kind: "error",
                    id: `e${parts.length}`,
                    message: event.error
                });
            }
            return;

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

        case "contextUsage":
        case "usage":
        case "availableCommands":
            return;

        default:
            // A new AgentEvent variant in Rust fails the build here until
            // it's handled.
            event satisfies never;
    }
}

function findTool(parts: MessagePart[], id: string) {
    const part = parts.find((p) => p.kind === "tool" && p.id === id);
    return part?.kind === "tool" ? part : undefined;
}
