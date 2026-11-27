import { use, useState, type ReactNode } from "react";
import { Collapsible } from "@base-ui/react/collapsible";
import { CaretRightIcon, CheckIcon, CopyIcon } from "@phosphor-icons/react";
import type { Message, MessagePart } from "@/proto";
import { useCopy } from "@/lib/clipboard";
import { cn } from "@/lib/cn";
import { formatElapsed, useNow } from "@/lib/time";
import { useSettingsStore } from "@/features/settings";
import { Tooltip } from "@/ui";
import { pendingInput } from "../fold";
import { LiveTasks } from "./context";
import { lineClassName, panelTransition, verbClassName } from "./line";
import { drawsAny } from "./blocks";
import { TurnParts } from "./Parts";
import { isShowing } from "./showing";
import { subagentState } from "./subagents";
import { ThoughtIcon } from "./ThoughtIcon";
import { isRunning } from "./tools";

const formatDuration = (ms: number) => formatElapsed(ms, { round: true });

/** A turn's parts, stacked. */
const STACK = "flex flex-col gap-3 compact:gap-2";

const headerClassName = "flex h-6 max-w-full items-center gap-1.5 text-left text-[13px] text-muted/85 tabular-nums";

/** The row over a turn's work, ruled off from it. */
function HeaderRow({ children }: { children: ReactNode }) {
    return <div className="border-b border-border pb-2">{children}</div>;
}

/** Over a turn in progress, where "Worked for" lands once it ends: "Working for 1m 5s", or "Waiting for you" while it asks something. */
function WorkingHeader({ since, waiting }: { since: number; waiting: boolean }) {
    const now = useNow();
    return (
        <HeaderRow>
            <div className={headerClassName}>
                {waiting ? "Waiting for you" : `Working for ${formatDuration(now - since)}`}
            </div>
        </HeaderRow>
    );
}

/** Under a running turn while nothing at its tail is live: a shimmering "Thinking". */
function ActivityRow({ label }: { label: string }) {
    return (
        <div className={lineClassName}>
            <ThoughtIcon className="size-3.5 shrink-0 text-muted/70" />
            <span className={cn(verbClassName, "shimmer")}>{label}</span>
        </div>
    );
}

/**
 * Whether a running turn's tail already shows it's alive: the reply
 * streaming, a thought, a call or compaction under way.
 */
function tailIsLive(parts: MessagePart[]): boolean {
    const tail = parts.findLast((p) => !((p.kind === "text" || p.kind === "reasoning") && !p.text.trim()));
    switch (tail?.kind) {
        case "text":
        case "reasoning":
            return true;
        case "tool":
            return isRunning(tail, true);
        case "compaction":
            return tail.status === "running";
        default:
            return false;
    }
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

/** "Worked for 1m 5s"; "Stopped after 12s" for a turn cut short. Nothing for a finished turn with no time. */
function workedLabel(message: Message, hasWork: boolean): string | null {
    const duration = message.durationMs !== undefined ? formatDuration(message.durationMs) : null;
    if (message.status === "aborted") return duration ? `Stopped after ${duration}` : "Stopped";
    return duration ? `Worked for ${duration}` : hasWork ? "Worked" : null;
}

const isWork = (part: MessagePart) =>
    (part.kind === "tool" && !isShowing(part)) || (part.kind === "reasoning" && !!part.text.trim());

/** What stays in view when a turn's work folds: what it asked, showed, or woke for. */
const isKept = (part: MessagePart) =>
    part.kind === "input" || part.kind === "wake" || (part.kind === "tool" && isShowing(part));

/** A stretch of a finished turn: parts that stay in view, then the work after them that folds. */
type Section = { lead: MessagePart[]; work: MessagePart[] };

/** The turn up to its last bit of work, cut into sections at each part that stays in view. */
function toSections(parts: MessagePart[]): Section[] {
    const sections: Section[] = [{ lead: [], work: [] }];
    for (const part of parts) {
        const current = sections.at(-1)!;
        if (!isKept(part)) current.work.push(part);
        else if (current.work.length) sections.push({ lead: [part], work: [] });
        else current.lead.push(part);
    }
    return sections;
}

/**
 * What the agent did and said in one turn, in order: markdown, and thoughts
 * and tool calls grouped (consecutive file edits on one line), and errors.
 * While the turn runs, "Working for 1m 5s" sits over it and "Thinking" under
 * it whenever nothing else there is live. Once done, its work folds behind
 * "Worked for 1m 5s" in that row's place, leaving the answer (and what the
 * agent asked or showed on the way); `fold={false}` keeps the work open.
 */
export function AssistantMessage({ message, fold = true }: { message: Message; fold?: boolean }) {
    const streaming = message.status === "streaming";
    const parts = message.parts;
    // What copy takes: the text after the last bit of work, i.e. the answer.
    const lastWork = parts.findLastIndex((p) => p.kind !== "text");
    const answer = parts
        .slice(lastWork + 1)
        .flatMap((p) => (p.kind === "text" && p.text.trim() ? [p.text] : []))
        .join("\n\n");

    const show = useSettingsStore((s) => s.settings.chat.toolCalls);
    // Settings › Chats can keep thoughts or tool output open; the turn stays open with them.
    const expanded = useSettingsStore((s) => s.settings.chat.toolOutputExpanded || s.settings.chat.reasoningExpanded);
    const live = use(LiveTasks);
    const [userOpen, setUserOpen] = useState<boolean>();

    // What opens the turn and stays in view (a wake divider) sits over the header.
    const firstOther = parts.findIndex((p) => !isKept(p));
    const leadCount = firstOther < 0 ? parts.length : firstOther;

    if (streaming) {
        const waiting = !!pendingInput(parts);
        // "Final reply only" shows none of the work, so nothing there is live but the reply.
        const finalOnly = show === "final-only";
        const idle = !waiting && (finalOnly ? parts.at(-1)?.kind !== "text" : !tailIsLive(parts));
        return (
            <div className={STACK}>
                <TurnParts parts={parts.slice(0, leadCount)} streaming />
                <WorkingHeader since={message.createdAt} waiting={waiting} />
                <TurnParts parts={parts.slice(leadCount)} streaming />
                {idle && <ActivityRow label={finalOnly ? "Working" : "Thinking"} />}
            </div>
        );
    }

    const foldEnd = parts.findLastIndex(isWork);
    // "Final reply only" already drops the work, interim text included.
    const sections = fold && show !== "final-only" ? toSections(parts.slice(0, foldEnd + 1)) : [];
    const foldable = sections.some((s) => drawsAny(s.work, show));
    const label = workedLabel(message, foldEnd >= 0);
    // A subagent still running in the background never hides behind the fold.
    const running = parts.some(
        (p) =>
            p.kind === "tool" &&
            p.call.kind === "subagent" &&
            subagentState(
                p,
                false,
                live.some((t) => t.toolCallId === p.id)
            ) === "running"
    );
    const open = userOpen ?? (expanded || running);

    const footer = answer && (
        <div className="-mt-1 flex h-6 items-center">
            <CopyButton text={answer} />
        </div>
    );

    if (!foldable) {
        return (
            <div className={STACK}>
                <TurnParts parts={parts.slice(0, leadCount)} streaming={false} />
                {label && (
                    <HeaderRow>
                        <div className={headerClassName}>{label}</div>
                    </HeaderRow>
                )}
                <TurnParts parts={parts.slice(leadCount)} streaming={false} />
                {footer}
            </div>
        );
    }

    return (
        <div className={STACK}>
            {sections.map((section, i) => (
                <Collapsible.Root key={i} open={open} onOpenChange={setUserOpen} className="flex flex-col">
                    {section.lead.length > 0 && (
                        <div className={i === 0 ? `${STACK} pb-3 compact:pb-2` : STACK}>
                            <TurnParts parts={section.lead} streaming={false} />
                        </div>
                    )}
                    {i === 0 && (
                        <HeaderRow>
                            <Collapsible.Trigger
                                className={`${headerClassName} group/header transition-colors hover:text-text/80`}
                            >
                                {label ?? "Worked"}
                                <CaretRightIcon
                                    weight="bold"
                                    className="size-3 shrink-0 opacity-80 transition-transform duration-200 group-data-panel-open/header:rotate-90"
                                />
                            </Collapsible.Trigger>
                        </HeaderRow>
                    )}
                    {drawsAny(section.work, show) && (
                        <Collapsible.Panel className={panelTransition}>
                            <div className={`${STACK} pt-3 compact:pt-2`}>
                                <TurnParts parts={section.work} streaming={false} />
                            </div>
                        </Collapsible.Panel>
                    )}
                </Collapsible.Root>
            ))}
            <TurnParts parts={parts.slice(foldEnd + 1)} streaming={false} />
            {footer}
        </div>
    );
}
