import { CaretRightIcon, TerminalWindowIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/cn";
import { formatElapsed } from "@/lib/time";
import { chats } from "@/features/chats/store";
import { ClaudeMark, useCatalog } from "@/features/models";
import { CARD_DWELL } from "@/features/sidebar/ChatRow";
import { Tooltip } from "@/ui";
import {
    progressLine,
    resultLine,
    spawnResult,
    SUBAGENT_STATE,
    subagentName,
    useSubagent,
    type SubagentPhase
} from "./subagents";
import { singleLine, type ToolPart } from "./tools";

/** A subagent's round avatar: the agent's mark, its state as a dot on the corner. */
export function SubagentAvatar({ state }: { state: SubagentPhase }) {
    return (
        <span className="relative inline-flex size-6 shrink-0 items-center justify-center rounded-full border border-border bg-surface">
            <ClaudeMark className="size-3.5" />
            <span
                className={cn(
                    "absolute -right-px -bottom-px size-2 rounded-full ring-2 ring-bg",
                    SUBAGENT_STATE[state].dot
                )}
            />
        </span>
    );
}

/**
 * Consecutive subagent spawns, one row each, so a running one is visible
 * without opening anything.
 */
export function SubagentStack({ parts, streaming }: { parts: ToolPart[]; streaming: boolean }) {
    return (
        <div className="-mx-2 flex flex-col">
            {parts.map((part) => (
                <SubagentRow key={part.id} part={part} streaming={streaming} />
            ))}
        </div>
    );
}

/**
 * A spawned subagent: a round avatar (the agent's mark, a status dot on its
 * corner), the task over what it last said, its state or the first line of
 * its result, and how long it ran. Hovering shows its card; a click opens its
 * thread in the main pane.
 */
function SubagentRow({ part, streaming }: { part: ToolPart; streaming: boolean }) {
    const { state, elapsed } = useSubagent(part, streaming);
    const call = part.call;
    if (call.kind !== "subagent") return null;
    const running = state === "running";
    const failed = state === "failed";
    const visual = SUBAGENT_STATE[state];
    // A background agent's result never comes back on its call: its last words stand in.
    const detail = running
        ? progressLine(part.thread)
        : (resultLine(spawnResult(part)) ?? progressLine(part.thread));
    const title = subagentName(part);

    const row = (
        <button
            type="button"
            aria-label={`Open ${title}`}
            onClick={() => chats.openSubagent(part.id)}
            className="group/subagent flex w-full min-w-0 cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-hover/60 focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:outline-none focus-visible:ring-inset"
        >
            <SubagentAvatar state={state} />
            <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-medium text-text">{title}</span>
                <span className={cn("block truncate text-[11px] leading-relaxed", failed ? "text-danger" : "text-muted")}>
                    {/* Shimmer on a span the text's width, as tool labels do. */}
                    <span className={cn(running && !detail && "shimmer")}>{detail ?? visual.label}</span>
                </span>
            </span>
            {detail !== null && state !== "done" && (
                <span className={cn("shrink-0 text-xs", failed ? "text-danger" : "text-muted", running && "shimmer")}>
                    {visual.label}
                </span>
            )}
            {elapsed !== null && (
                <span className="shrink-0 text-xs text-muted tabular-nums">
                    {formatElapsed(elapsed, { round: true })}
                </span>
            )}
            <CaretRightIcon className="size-3.5 shrink-0 text-muted/70 transition-colors group-hover/subagent:text-text" />
        </button>
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
                <SubagentCard title={title} model={call.model} prompt={call.prompt} state={state} elapsed={elapsed} />
            </Tooltip.Content>
        </Tooltip>
    );
}

/**
 * What a subagent row has no room for, in its hover card (like the sidebar's
 * chat card): the whole task, the model it runs on, how it stands and for how
 * long, and the prompt it was given.
 */
function SubagentCard({
    title,
    model,
    prompt,
    state,
    elapsed
}: {
    title: string;
    model?: string;
    prompt?: string;
    state: SubagentPhase;
    elapsed: number | null;
}) {
    const catalog = useCatalog();
    // A model the spawn named, by its label when the catalog knows it; else the chat's.
    const named = model
        ? (catalog?.models.find((m) => m.id === model || m.label.toLowerCase().includes(model.toLowerCase()))
              ?.label ?? model)
        : null;
    const visual = SUBAGENT_STATE[state];
    return (
        <div className="flex flex-col gap-2.5">
            <p className="text-[13px] leading-snug font-medium break-words text-text">{title}</p>
            <div className="flex flex-col gap-1.5 border-t border-border pt-2.5 text-xs">
                <div className="flex min-w-0 items-center gap-2">
                    <span className="flex w-4 shrink-0 justify-center">
                        <ClaudeMark className="size-3.5" />
                    </span>
                    <span className="min-w-0 truncate text-text/85">
                        {named ?? (
                            <>
                                Claude
                                <span className="text-muted/75"> · chat's model</span>
                            </>
                        )}
                    </span>
                </div>
                <div className="flex min-w-0 items-center gap-2">
                    <span className="flex w-4 shrink-0 justify-center">
                        <span className={cn("size-2 rounded-full", visual.dot)} />
                    </span>
                    <span className={cn("min-w-0 flex-1 truncate", state === "failed" ? "text-danger" : "text-text/85")}>
                        {visual.label}
                    </span>
                    {elapsed !== null && (
                        <span className="shrink-0 text-muted/75 tabular-nums">
                            {formatElapsed(elapsed, { round: true })}
                        </span>
                    )}
                </div>
                {prompt && (
                    <div className="flex min-w-0 items-center gap-2">
                        <span className="flex w-4 shrink-0 justify-center">
                            <TerminalWindowIcon className="size-3.5 text-muted" />
                        </span>
                        <span className="min-w-0 truncate text-muted">{singleLine(prompt)}</span>
                    </div>
                )}
            </div>
        </div>
    );
}
