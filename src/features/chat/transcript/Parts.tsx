import type { ReactNode } from "react";
import { WarningCircleIcon } from "@phosphor-icons/react";
import type { MessagePart } from "@/proto";
import { useSettingsStore } from "@/features/settings";
import { InputRecord } from "./InputRecord";
import { Markdown } from "./Markdown";
import { CompactionDivider, WakeDivider } from "./Dividers";
import { Shown } from "./Shown";
import { SubagentStack } from "./Subagent";
import { ToolGroup } from "./ToolGroup";
import { toBlocks, type Block } from "./blocks";

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
