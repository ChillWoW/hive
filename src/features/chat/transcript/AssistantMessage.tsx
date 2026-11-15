import type { ReactNode } from "react";
import { CheckIcon, CopyIcon, WarningCircleIcon } from "@phosphor-icons/react";
import type { Message, MessagePart } from "@/proto";
import { useCopy } from "@/lib/clipboard";
import { formatElapsed, useNow } from "@/lib/time";
import { DotMatrixSpinner, Tooltip } from "@/ui";
import { Markdown } from "./Markdown";
import { ToolGroup } from "./ToolGroup";
import { pushCall, type GroupItem } from "./tools";

/** What a turn renders as, in order: a group of calls and thoughts, or a single part. */
type Block =
    | { kind: "group"; items: GroupItem[]; first: number; last: number }
    | { kind: "part"; part: MessagePart; index: number };

/**
 * Consecutive tool calls and thoughts fold into one group; text or an error
 * ends it. Empty text and empty thoughts draw nothing and so split nothing.
 */
function toBlocks(parts: MessagePart[], streaming: boolean): Block[] {
    const blocks: Block[] = [];
    let open: Extract<Block, { kind: "group" }> | undefined;
    const last = parts.length - 1;

    parts.forEach((part, index) => {
        if ((part.kind === "text" || part.kind === "reasoning") && !part.text.trim()) return;
        if (part.kind === "tool" || part.kind === "reasoning") {
            if (!open) blocks.push((open = { kind: "group", items: [], first: index, last: index }));
            if (part.kind === "tool") pushCall(open.items, part);
            // Live only while it's the tail of the turn: once anything
            // follows, the thought is finished.
            else open.items.push({ kind: "thought", part, live: streaming && index === last });
            open.last = index;
            return;
        }
        open = undefined;
        blocks.push({ kind: "part", part, index });
    });
    return blocks;
}

const formatDuration = (ms: number) => formatElapsed(ms, { round: true });

/** The line under a turn in progress: a spinner, a shimmering "Working", and for how long. */
function WorkingStatus({ since }: { since: number }) {
    const now = useNow();
    return (
        <div className="flex items-center gap-2 text-sm">
            <DotMatrixSpinner label="Working" className="text-text/80" />
            <span className="shimmer font-[450] text-muted">Working</span>
            <span className="text-muted/85 tabular-nums">{formatDuration(now - since)}</span>
        </div>
    );
}

function CopyButton({ text }: { text: string }) {
    const [copied, copy] = useCopy();
    return (
        <Tooltip>
            <Tooltip.Trigger
                render={
                    <button
                        type="button"
                        aria-label="Copy"
                        onClick={() => copy(text)}
                        className="inline-flex size-6 items-center justify-center rounded-sm text-muted/85 transition-colors hover:bg-hover hover:text-text"
                    >
                        {copied ? (
                            <CheckIcon className="size-3.5" weight="bold" />
                        ) : (
                            <CopyIcon className="size-3.5" />
                        )}
                    </button>
                }
            />
            <Tooltip.Content side="bottom">{copied ? "Copied" : "Copy"}</Tooltip.Content>
        </Tooltip>
    );
}

function ErrorChip({ message }: { message: string }) {
    return (
        <span className="inline-flex min-h-7 max-w-full items-center gap-1.5 self-start rounded-[9px] border border-danger/25 bg-danger/10 px-2.5 py-1 text-xs text-danger">
            <WarningCircleIcon className="size-3.5 shrink-0" weight="fill" />
            <span className="min-w-0 break-words whitespace-pre-wrap">{message}</span>
        </span>
    );
}

/**
 * What the agent did and said in one turn, in order: markdown, and thoughts
 * and tool calls grouped (consecutive file edits on one line), and errors.
 * While the turn runs a status line sits under it; once done, a copy button
 * and how long it took.
 */
export function AssistantMessage({ message }: { message: Message }) {
    const streaming = message.status === "streaming";
    const parts = message.parts;
    const last = parts.length - 1;
    const lastText = parts.findLastIndex((p) => p.kind === "text");
    // What copy takes: the text after the last bit of work, i.e. the answer.
    const lastWork = parts.findLastIndex((p) => p.kind !== "text");
    const answer = parts
        .slice(lastWork + 1)
        .flatMap((p) => (p.kind === "text" && p.text.trim() ? [p.text] : []))
        .join("\n\n");

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
            default:
                return null;
        }
    };

    return (
        <div className="flex flex-col gap-3">
            {toBlocks(parts, streaming).map(render)}
            {streaming && <WorkingStatus since={message.createdAt} />}
            {!streaming && (
                <div className="-mt-1 flex h-6 items-center gap-2 text-xs text-muted/85">
                    {answer && <CopyButton text={answer} />}
                    {message.durationMs !== undefined && (
                        <span className="tabular-nums">{formatDuration(message.durationMs)}</span>
                    )}
                    {message.status === "aborted" && <span>Stopped</span>}
                </div>
            )}
        </div>
    );
}
