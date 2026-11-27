import type { ReactNode } from "react";
import { WarningCircleIcon } from "@phosphor-icons/react";
import type { MessagePart } from "@/proto";
import { useSettingsStore, type ToolCalls } from "@/features/settings";
import { InputRecord } from "./InputRecord";
import { Markdown } from "./Markdown";
import { CompactionDivider, WakeDivider } from "./Dividers";
import { Shown } from "./Shown";
import { isShowing } from "./showing";
import { SubagentStack } from "./Subagent";
import { ToolGroup } from "./ToolGroup";
import { pushCall, type GroupItem, type ToolPart } from "./tools";

/** Tools whose call is the question or plan an `input` part already shows. */
const ASKING_TOOLS = new Set(["AskUserQuestion", "ExitPlanMode"]);

/**
 * What a turn renders as, in order: a group of calls and thoughts, a stack of
 * subagent rows, or a single part.
 */
type Block =
    | { kind: "group"; items: GroupItem[]; first: number; last: number }
    | { kind: "agents"; parts: ToolPart[]; first: number }
    | { kind: "part"; part: MessagePart; index: number };

/**
 * Consecutive tool calls and thoughts fold into one group; anything else
 * ends it. Subagent spawns gather into their own run, so a running subagent
 * never hides behind a fold. Empty text and empty thoughts draw nothing and
 * so split nothing.
 */
function toBlocks(parts: MessagePart[], streaming: boolean, show: ToolCalls): Block[] {
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

export function ErrorChip({ message }: { message: string }) {
    return (
        <span className="inline-flex min-h-7 max-w-full items-center gap-1.5 self-start rounded-[9px] border border-danger/25 bg-danger/10 px-2.5 py-1 text-xs text-danger">
            <WarningCircleIcon className="size-3.5 shrink-0" weight="fill" />
            <span className="min-w-0 break-words whitespace-pre-wrap">{message}</span>
        </span>
    );
}

/**
 * A turn's parts, in order: markdown, thoughts and tool calls grouped
 * (consecutive file edits on one line), what the agent asked, compactions,
 * subagents, and errors. Also a subagent's thread, under its row.
 */
export function TurnParts({ parts, streaming }: { parts: MessagePart[]; streaming: boolean }) {
    const last = parts.length - 1;
    const lastText = parts.findLastIndex((p) => p.kind === "text");
    const show = useSettingsStore((s) => s.settings.chat.toolCalls);

    const render = (block: Block): ReactNode => {
        if (block.kind === "group") {
            return (
                <ToolGroup
                    // Keyed by where it starts, so it keeps its fold state as it grows.
                    key={`g${block.first}`}
                    items={block.items}
                    // Open while it's the tail of a running turn.
                    active={streaming && block.last === last}
                    streaming={streaming}
                />
            );
        }
        if (block.kind === "agents") {
            return <SubagentStack key={`a${block.first}`} parts={block.parts} streaming={streaming} />;
        }
        const { part, index } = block;
        switch (part.kind) {
            case "text":
                return (
                    <Markdown key={part.id} streaming={streaming && index === lastText}>
                        {part.text}
                    </Markdown>
                );
            case "error":
                return <ErrorChip key={part.id} message={part.message} />;
            case "input":
                return <InputRecord key={part.id} part={part} />;
            case "compaction":
                return <CompactionDivider key={part.id} part={part} />;
            case "tool":
                return <Shown key={part.id} part={part} />;
            case "wake":
                return <WakeDivider key={part.id} part={part} />;
            default:
                return null;
        }
    };

    return <>{toBlocks(parts, streaming, show).map(render)}</>;
}
