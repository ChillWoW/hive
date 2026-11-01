import {
    ArrowElbowDownRightIcon,
    ArrowsInLineVerticalIcon,
    CaretRightIcon,
    ChatCircleDotsIcon,
    RobotIcon,
    TerminalWindowIcon,
    WarningCircleIcon
} from "@phosphor-icons/react";
import { useContext, type ReactNode } from "react";
import type { FinishedTask, HarnessId, MessagePart } from "@/proto";
import { HarnessIcon, useCatalog } from "@/harnesses";
import { cn } from "@/lib/cn";
import { Tooltip } from "@/ui";
import { formatTokens } from "@/lib/format";
import { OpenSubagent } from "./context";
import {
    plainLine,
    progressLine,
    spawnResult,
    SUBAGENT_STATE,
    useSubagent,
    type SubagentPhase
} from "./subagents";
import { formatElapsed } from "@/lib/time";
import { singleLine, type ToolPart } from "./tools";

type Part<K extends MessagePart["kind"]> = Extract<MessagePart, { kind: K }>;

/** The first line of a subagent's result, as plain text. */
function resultLine(output: string | undefined): string | null {
    return output?.split("\n").map(plainLine).find(Boolean) ?? null;
}

/** The harness's mark, else a robot. */
export function AgentMark({ harness }: { harness?: HarnessId }) {
    return harness ? (
        <HarnessIcon harness={harness} className="size-3.5" />
    ) : (
        <RobotIcon className="size-3.5 text-dark-200" />
    );
}

/**
 * The round avatar subagents and background tasks share; the glyph inside and
 * the badge on its corner are the caller's.
 */
export function RoundAvatar({ className, children }: { className?: string; children: ReactNode }) {
    return (
        <span
            className={cn(
                "relative inline-flex size-6 shrink-0 items-center justify-center rounded-full border border-dark-600 bg-dark-800",
                className
            )}
        >
            {children}
        </span>
    );
}

/** A subagent's round avatar: the harness's mark, its state as a dot on the corner. */
export function SubagentAvatar({ harness, state }: { harness?: HarnessId; state: SubagentPhase }) {
    return (
        <RoundAvatar className="ring-2 ring-dark-900">
            <AgentMark harness={harness} />
            <span
                className={cn(
                    "absolute -right-px -bottom-px size-2 rounded-full ring-2 ring-dark-900",
                    SUBAGENT_STATE[state].dot
                )}
            />
        </RoundAvatar>
    );
}

/**
 * A spawned subagent: a round avatar (the harness's
 * mark, a status dot on its corner), the task over what it last said, its
 * state or the first line of its result, and how long it ran. A row of its
 * own rather than a line in a tool group, so a running one is visible without
 * opening anything; click opens its thread in the main pane.
 */
export function SubagentChip({
    part,
    streaming,
    harness
}: {
    part: ToolPart;
    streaming: boolean;
    harness?: HarnessId;
}) {
    const open = useContext(OpenSubagent);
    const { state, elapsed } = useSubagent(part, streaming);
    const running = state === "running";
    const call = part.call;
    if (call.kind !== "subagent") return null;
    const visual = SUBAGENT_STATE[state];
    const failed = state === "failed";
    // A background agent's result never comes back on its call: its last words stand in.
    const detail = running
        ? progressLine(part.thread)
        : (resultLine(spawnResult(part)) ?? progressLine(part.thread));
    const title = call.description || "Subagent";

    const content = (
        <>
            <SubagentAvatar harness={harness} state={state} />
            <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-medium text-dark-50">{title}</span>
                <span
                    className={cn(
                        "block truncate text-[11px] leading-relaxed",
                        failed ? "text-danger" : "text-dark-200"
                    )}
                >
                    {/* Shimmer on a span the text's width, as tool labels do. */}
                    <span className={cn(running && !detail && "shimmer")}>{detail ?? visual.label}</span>
                </span>
            </span>
            {detail !== null && state !== "done" && (
                <span
                    className={cn(
                        "shrink-0 text-xs",
                        failed ? "text-danger" : "text-dark-200",
                        running && "shimmer"
                    )}
                >
                    {visual.label}
                </span>
            )}
            {elapsed !== null && (
                <span className="shrink-0 text-xs text-dark-200 tabular-nums">{formatElapsed(elapsed)}</span>
            )}
            {open && (
                <CaretRightIcon className="size-3.5 shrink-0 text-dark-250 transition-colors group-hover/subagent:text-dark-50" />
            )}
        </>
    );
    const className = "group/subagent flex w-full min-w-0 items-center gap-2.5 rounded-md px-2 py-1.5 text-left";
    const row = open ? (
        <button
            type="button"
            aria-label={`Open ${title}`}
            onClick={() => open(part.id)}
            className={cn(
                className,
                "cursor-pointer transition-colors hover:bg-white/[0.04] focus-visible:ring-2 focus-visible:ring-primary-500/60 focus-visible:outline-none focus-visible:ring-inset"
            )}
        >
            {content}
        </button>
    ) : (
        <div className={className}>{content}</div>
    );
    return (
        <Tooltip disableHoverablePopup>
            <Tooltip.Trigger delay={CARD_DWELL} closeOnClick render={row} />
            <Tooltip.Content
                side="top"
                align="start"
                sideOffset={6}
                collisionPadding={12}
                className="w-[300px] max-w-none p-3 font-normal"
            >
                <SubagentCard
                    title={title}
                    model={call.model}
                    prompt={call.prompt}
                    harness={harness}
                    state={state}
                    elapsed={elapsed}
                />
            </Tooltip.Content>
        </Tooltip>
    );
}

/** How long the pointer rests on a subagent row before its card shows, as the sidebar's. */
const CARD_DWELL = 300;

/**
 * What a subagent row has no room for, in its hover card (like the
 * sidebar's chat card): the whole task, the model it runs on, how it
 * stands and for how long, and the prompt it was given.
 */
function SubagentCard({
    title,
    model,
    prompt,
    harness,
    state,
    elapsed
}: {
    title: string;
    model?: string;
    prompt?: string;
    harness?: HarnessId;
    state: SubagentPhase;
    elapsed: number | null;
}) {
    const catalog = useCatalog(harness);
    // A model the spawn named, by its label when the catalog knows it; else the chat's.
    const named = model
        ? (catalog?.models.find((m) => m.id === model || m.label.toLowerCase().includes(model.toLowerCase()))
              ?.label ?? model)
        : null;
    const visual = SUBAGENT_STATE[state];
    return (
        <div className="flex flex-col gap-2.5">
            <p className="text-[13px] leading-snug font-medium break-words text-dark-50">{title}</p>
            <div className="flex flex-col gap-1.5 border-t border-dark-600 pt-2.5 text-xs">
                <div className="flex min-w-0 items-center gap-2">
                    <span className="flex w-4 shrink-0 justify-center">
                        <AgentMark harness={harness} />
                    </span>
                    <span className="min-w-0 truncate text-dark-100">
                        {named ?? (
                            <>
                                {catalog?.label ?? "Agent"}
                                <span className="text-dark-250"> · chat's model</span>
                            </>
                        )}
                    </span>
                </div>
                <div className="flex min-w-0 items-center gap-2">
                    <span className="flex w-4 shrink-0 justify-center">
                        <span className={cn("size-2 rounded-full", visual.dot)} />
                    </span>
                    <span
                        className={cn(
                            "min-w-0 flex-1 truncate",
                            state === "failed" ? "text-danger" : "text-dark-100"
                        )}
                    >
                        {visual.label}
                    </span>
                    {elapsed !== null && (
                        <span className="shrink-0 text-dark-250 tabular-nums">{formatElapsed(elapsed)}</span>
                    )}
                </div>
                {prompt && (
                    <div className="flex min-w-0 items-center gap-2">
                        <span className="flex w-4 shrink-0 justify-center">
                            <TerminalWindowIcon className="size-3.5 text-dark-200" />
                        </span>
                        <span className="min-w-0 truncate text-dark-200">{singleLine(prompt)}</span>
                    </div>
                )}
            </div>
        </div>
    );
}

export function ErrorChip({ message }: { message: string }) {
    return (
        <span className="inline-flex min-h-7 max-w-full items-center gap-1.5 self-start rounded-[9px] border border-danger/25 bg-danger/10 px-2.5 py-1 text-xs text-danger">
            <WarningCircleIcon className="size-3.5 shrink-0" weight="fill" />
            <span className="min-w-0 break-words whitespace-pre-wrap">{message}</span>
        </span>
    );
}

const ENDED: Record<FinishedTask["status"], string> = {
    completed: "finished",
    failed: "failed",
    stopped: "was stopped"
};

/**
 * Opens a reply the agent started on its own: which background work ended
 * and woke it ("After *Run the tests* finished").
 */
export function WakeRow({ part }: { part: Part<"wake"> }) {
    const [first, ...rest] = part.finished;
    const label = !first
        ? "Continued on its own"
        : rest.length === 0
          ? `After`
          : `After ${part.finished.length} background tasks ended`;
    return (
        <MarkerRow icon={<ArrowElbowDownRightIcon className="size-3.5 text-dark-200" />}>
            <span className="shrink-0 text-dark-200">{label}</span>
            {first && rest.length === 0 && (
                <>
                    <span className="min-w-0 truncate text-dark-100">{first.description || "a background task"}</span>
                    <span className={cn("shrink-0", first.status === "failed" ? "text-danger" : "text-dark-200")}>
                        {ENDED[first.status]}
                    </span>
                </>
            )}
            {rest.length > 0 && (
                <span className="min-w-0 truncate text-dark-250">
                    {part.finished.map((t) => t.description).join(", ")}
                </span>
            )}
        </MarkerRow>
    );
}

/** A one-line marker in a reply, its icon in a tool group's caret column. */
function MarkerRow({ icon, children }: { icon: ReactNode; children: ReactNode }) {
    return (
        <div className="flex h-[26px] min-w-0 items-center gap-1.5 text-xs">
            <span className="flex w-[22px] shrink-0 justify-center">{icon}</span>
            {children}
        </div>
    );
}

/** The words for a compaction, as its divider shows it. */
function compactionLabel(part: Part<"compaction">, live: boolean): string {
    switch (part.status) {
        case "running":
            return live ? "Compacting context" : "Context compaction stopped";
        case "completed":
            return part.auto ? "Context compacted automatically" : "Context compacted";
        case "failed":
            return "Context compaction failed";
        case "stopped":
            return "Context compaction stopped";
    }
}

/**
 * A context compaction (`/compact`, or the agent's own): a divider across
 * the transcript — shimmering while it runs, then where it
 * ended with the context's size before and after, or why it failed.
 */
export function CompactionRow({ part, streaming }: { part: Part<"compaction">; streaming: boolean }) {
    const live = part.status === "running" && streaming;
    const failed = part.status === "failed";
    const tokens =
        part.status === "completed" && (part.beforeTokens ?? part.afterTokens) !== undefined
            ? `${part.beforeTokens !== undefined ? formatTokens(part.beforeTokens) : "?"} → ${
                  part.afterTokens !== undefined ? formatTokens(part.afterTokens) : "?"
              } tokens`
            : null;
    return (
        <div role="separator" className="flex min-w-0 items-center gap-3 py-1 text-xs">
            <span className="h-px flex-1 bg-dark-700" />
            <span className="flex min-w-0 max-w-[80%] items-center gap-1.5">
                {failed ? (
                    <WarningCircleIcon className="size-3.5 shrink-0 text-danger" weight="fill" />
                ) : (
                    <ArrowsInLineVerticalIcon className="size-3.5 shrink-0 text-dark-200" />
                )}
                <span className={cn("shrink-0 text-dark-200", live && "shimmer")}>
                    {compactionLabel(part, live)}
                </span>
                {tokens && <span className="shrink-0 text-dark-250 tabular-nums">{tokens}</span>}
                {failed && part.error && (
                    <span className="min-w-0 truncate text-danger">· {part.error}</span>
                )}
            </span>
            <span className="h-px flex-1 bg-dark-700" />
        </div>
    );
}

/** Where the agent asked something: waiting while unanswered (the wizard is below), a line after. */
export function InputRow({ part, streaming }: { part: Part<"input">; streaming: boolean }) {
    const waiting = !part.resolved && streaming;
    const count = part.questions.length;
    const label = part.resolved
        ? `Answered ${count === 1 ? "a question" : `${count} questions`}`
        : waiting
          ? "Waiting for your answer"
          : "Question not answered";
    return (
        <MarkerRow icon={<ChatCircleDotsIcon className="size-3.5 text-dark-200" />}>
            <span className={cn("shrink-0 text-dark-200", waiting && "shimmer")}>{label}</span>
            {part.questions[0] && (
                <span className="min-w-0 truncate text-dark-250">{part.questions[0].question}</span>
            )}
        </MarkerRow>
    );
}
