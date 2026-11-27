import type { MessagePart } from "@/proto";
import type { ToolCalls } from "@/features/settings";
import { isShowing } from "./showing";
import { pushCall, type GroupItem, type ToolPart } from "./tools";

/** Tools whose call is the question or plan an `input` part already shows. */
const ASKING_TOOLS = new Set(["AskUserQuestion", "ExitPlanMode"]);

/**
 * What a turn renders as, in order: a group of calls and thoughts, a stack of
 * subagent rows, or a single part.
 */
export type Block =
    | { kind: "group"; items: GroupItem[]; first: number; last: number }
    | { kind: "agents"; parts: ToolPart[]; first: number }
    | { kind: "part"; part: MessagePart; index: number };

/**
 * Consecutive tool calls and thoughts fold into one group; anything else
 * ends it. Subagent spawns gather into their own run, so a running subagent
 * never hides behind a fold. Empty text and empty thoughts draw nothing and
 * so split nothing.
 */
export function toBlocks(parts: MessagePart[], streaming: boolean, show: ToolCalls): Block[] {
    const blocks: Block[] = [];
    let open: Extract<Block, { kind: "group" | "agents" }> | undefined;
    const last = parts.length - 1;
    const finalOnly = show === "final-only";
    // The reply is the text after the turn's last bit of work.
    const lastWork = finalOnly ? parts.findLastIndex((p) => p.kind === "tool" || p.kind === "reasoning") : -1;
    // Hidden calls still open and split blocks as shown ones do (a block
    // left empty is dropped below), so keys hold as calls finish and go.
    const hidden = (part: ToolPart) => finalOnly || (show === "hide-successful" && succeeded(part));

    parts.forEach((part, index) => {
        if ((part.kind === "text" || part.kind === "reasoning") && !part.text.trim()) return;
        if (part.kind === "text" && index < lastWork) return;
        // Asking the user and presenting a plan show as what was asked.
        if (part.kind === "tool" && part.call.kind === "unknown" && ASKING_TOOLS.has(part.call.name)) return;
        // What Outcode's own tools show stands on its own, where it was called.
        if (part.kind === "tool" && isShowing(part)) {
            open = undefined;
            blocks.push({ kind: "part", part, index });
            return;
        }
        if (part.kind === "tool" && part.call.kind === "subagent") {
            if (open?.kind !== "agents") blocks.push((open = { kind: "agents", parts: [], first: index }));
            if (!hidden(part)) open.parts.push(part);
            return;
        }
        if (part.kind === "tool" || part.kind === "reasoning") {
            if (open?.kind !== "group") blocks.push((open = { kind: "group", items: [], first: index, last: index }));
            if (part.kind === "tool") {
                if (!hidden(part)) pushCall(open.items, part);
            }
            // Live only while it's the tail of the turn: once anything
            // follows, the thought is finished.
            else if (!finalOnly) open.items.push({ kind: "thought", part, live: streaming && index === last });
            open.last = index;
            return;
        }
        open = undefined;
        blocks.push({ kind: "part", part, index });
    });
    return blocks.filter((b) => (b.kind === "group" ? b.items.length : b.kind === "agents" ? b.parts.length : true));
}

/** A call that came back without an error; a subagent, once it's done. */
function succeeded(part: ToolPart) {
    return !!part.resolved && !part.isError && (part.subagent ?? "done") === "done";
}

/** Whether `parts` draw anything under the tool calls setting. */
export function drawsAny(parts: MessagePart[], show: ToolCalls): boolean {
    return toBlocks(parts, false, show).length > 0;
}
