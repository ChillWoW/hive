import type { AgentEvent, MessagePart } from "@/proto";

export type ToolPart = Extract<MessagePart, { kind: "tool" }>;

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
 * - `done` adds nothing: how the turn ended is the message's status.
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
            return [
                ...parts,
                { kind: "tool", id: event.id, call: event.call, resolved: false, isError: false }
            ];
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

        case "error":
            return [...parts, { kind: "error", id: `e${parts.length}`, message: event.message }];

        case "done":
            return parts;

        default:
            // A new AgentEvent variant in Rust fails the build here until
            // it's handled.
            event satisfies never;
            return parts;
    }
}

function toolIndex(parts: MessagePart[], id: string) {
    return parts.findIndex((p) => p.kind === "tool" && p.id === id);
}

function replace(parts: MessagePart[], index: number, part: MessagePart): MessagePart[] {
    const next = parts.slice();
    next[index] = part;
    return next;
}
