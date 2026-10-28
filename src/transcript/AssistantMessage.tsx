import { useEffect, useState, type ReactNode } from "react";
import { CheckIcon, CopyIcon } from "@phosphor-icons/react";
import type { Message, MessagePart } from "@/proto";
import { cn } from "@/lib/cn";
import { Tooltip } from "@/ui";
import { Markdown } from "./Markdown";
import { ErrorChip, InputRow, SubagentChip } from "./parts";
import { ToolGroup } from "./ToolGroup";
import type { GroupItem, ToolPart } from "./tools";

/**
 * What a turn renders as, in order: a group of calls and thoughts, a stack
 * of subagent cards, or a single part.
 */
type Block =
    | { kind: "group"; items: GroupItem[]; first: number; last: number }
    | { kind: "agents"; parts: ToolPart[]; first: number }
    | { kind: "part"; part: MessagePart; index: number };

const isAgent = (part: MessagePart) => part.kind === "tool" && part.call.kind === "subagent";

/**
 * Consecutive tool calls and thoughts fold into one group; text, a question
 * or an error ends it. Subagent spawns gather into their own run, so a
 * running subagent never hides behind a fold — whenever the genus flips, a
 * new block starts. Empty text and empty thoughts draw nothing and so split
 * nothing.
 */
function toBlocks(parts: MessagePart[], streaming: boolean): Block[] {
    const blocks: Block[] = [];
    let open: Extract<Block, { kind: "group" | "agents" }> | undefined;
    const last = parts.length - 1;

    parts.forEach((part, index) => {
        if ((part.kind === "text" || part.kind === "reasoning") && !part.text.trim()) return;

        if (isAgent(part)) {
            if (open?.kind !== "agents") blocks.push((open = { kind: "agents", parts: [], first: index }));
            open.parts.push(part as ToolPart);
            return;
        }
        if (part.kind === "tool" || part.kind === "reasoning") {
            if (open?.kind !== "group") {
                blocks.push((open = { kind: "group", items: [], first: index, last: index }));
            }
            open.items.push(
                part.kind === "tool"
                    ? { kind: "call", part }
                    // Live only while it's the tail of the turn: once
                    // anything follows, the thought is finished.
                    : { kind: "thought", part, live: streaming && index === last }
            );
            open.last = index;
            return;
        }
        open = undefined;
        blocks.push({ kind: "part", part, index });
    });
    return blocks;
}

function formatDuration(ms: number): string {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${s % 60}s`;
    return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function useNow(active: boolean) {
    const [now, setNow] = useState(Date.now);
    useEffect(() => {
        if (!active) return;
        const timer = window.setInterval(() => setNow(Date.now()), 1000);
        return () => window.clearInterval(timer);
    }, [active]);
    return now;
}

/** The line under a turn in progress: what it's doing and for how long. */
function WorkingStatus({ since, waiting }: { since: number; waiting: boolean }) {
    const now = useNow(true);
    const label = waiting ? "Waiting for you" : "Working";
    return (
        <div className="flex items-center gap-2 text-sm">
            <span className="relative flex size-2 shrink-0">
                {!waiting && (
                    <span className="absolute inline-flex size-full animate-ping rounded-full bg-dark-200 opacity-50" />
                )}
                <span
                    className={cn(
                        "relative inline-flex size-2 rounded-full",
                        waiting ? "bg-warning" : "bg-dark-100"
                    )}
                />
            </span>
            <span className={cn("font-[450] text-dark-200", !waiting && "shimmer")}>
                {label}
            </span>
            <span className="text-dark-250 tabular-nums">{formatDuration(now - since)}</span>
        </div>
    );
}

function CopyButton({ text }: { text: string }) {
    const [copied, setCopied] = useState(false);
    useEffect(() => {
        if (!copied) return;
        const timer = window.setTimeout(() => setCopied(false), 1500);
        return () => window.clearTimeout(timer);
    }, [copied]);

    return (
        <Tooltip>
            <Tooltip.Trigger
                render={
                    <button
                        type="button"
                        aria-label="Copy"
                        onClick={() => {
                            void navigator.clipboard.writeText(text).then(() => setCopied(true));
                        }}
                        className="inline-flex size-6 items-center justify-center rounded-sm text-dark-300 transition-colors hover:bg-dark-700 hover:text-dark-50"
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

/**
 * What the agent did and said in one turn, in order: markdown, thoughts,
 * tool calls (consecutive ones grouped), subagent and error chips. While the
 * turn runs a status line sits under it; once done, a copy button and how
 * long it took.
 */
export function AssistantMessage({
    message,
    waiting = false
}: {
    message: Message;
    /** The turn is held on a question for the user. */
    waiting?: boolean;
}) {
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
        switch (block.kind) {
            case "group":
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
            case "agents":
                return (
                    <div key={`a${block.first}`} className="flex flex-col gap-2">
                        {block.parts.map((part) => (
                            <SubagentChip key={part.id} part={part} streaming={streaming} />
                        ))}
                    </div>
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
            case "input":
                return <InputRow key={part.id} part={part} streaming={streaming} />;
            case "error":
                return <ErrorChip key={part.id} message={part.message} />;
            default:
                return null;
        }
    };

    return (
        <div className="flex flex-col gap-3">
            {toBlocks(parts, streaming).map(render)}
            {streaming && <WorkingStatus since={message.createdAt} waiting={waiting} />}
            {!streaming && (
                <div className="-mt-1 flex h-6 items-center gap-2 text-xs text-dark-300">
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
