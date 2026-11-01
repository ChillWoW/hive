import { useState } from "react";
import { ArrowsInLineVerticalIcon } from "@phosphor-icons/react";
import type { ContextUsage } from "@/proto";
import { cn } from "@/lib/cn";
import { formatCount } from "@/lib/format";
import { chipClassName } from "@/ui/chip";
import { Tooltip } from "@/ui";
import { cardActionClassName, ChipPopover } from "@/ui/ChipPopover";
import { Ring } from "./Ring";

/** `/compact` from the ring's card; `disabled` says why it can't run now. */
export type CompactAction = { run: () => void; disabled?: string };

/** The ring's tone and the card's bar colour, by how full the window is. */
const LEVELS = [
    { from: 0.9, text: "text-danger", bar: "bg-danger/90" },
    { from: 0.75, text: "text-warning", bar: "bg-warning/90" },
    { from: 0, text: "text-dark-200", bar: "bg-dark-200" }
];

/**
 * How full the chat's context window is, as a ring and percent under the
 * composer: muted, warning from 75%, danger from 90%; the
 * token counts in its tooltip. Nothing until the harness reports a window.
 * With `compact` (the harness has `/compact`) it opens a card instead, with
 * the counts and a Compact context button.
 */
export function ContextRing({
    usage,
    compact
}: {
    usage: ContextUsage | undefined;
    compact?: CompactAction;
}) {
    const [open, setOpen] = useState(false);
    const capacity = usage?.window;
    if (!capacity) return null;
    const tokens = usage.tokens;
    const fraction = tokens != null ? Math.min(tokens / capacity, 1) : null;
    const level = fraction == null ? undefined : LEVELS.find((l) => fraction >= l.from);
    const tone = level?.text ?? "text-dark-250";
    const percent = fraction == null ? "—" : `${Math.round(fraction * 100)}%`;
    const counts =
        tokens != null
            ? `${formatCount(tokens)} / ${formatCount(capacity)} tokens`
            : `${formatCount(capacity)} token window`;
    const chip = (
        <>
            <Ring fraction={fraction} />
            {percent}
        </>
    );

    if (!compact) {
        return (
            <Tooltip>
                <Tooltip.Trigger
                    render={
                        <span
                            aria-label="Context window"
                            className={cn(
                                chipClassName,
                                "shrink-0 cursor-default gap-1.5 px-1.5 tabular-nums",
                                tone
                            )}
                        >
                            {chip}
                        </span>
                    }
                />
                <Tooltip.Content side="top">
                    <span className="tabular-nums">{counts}</span>
                </Tooltip.Content>
            </Tooltip>
        );
    }

    return (
        <ChipPopover
            open={open}
            onOpenChange={setOpen}
            label="Context window"
            triggerClassName={cn("tabular-nums", tone)}
            trigger={chip}
            className="w-72"
        >
            <div className="flex flex-col gap-2 px-3 pt-3 pb-2.5">
                <div className="flex items-baseline justify-between gap-2">
                    <span className="text-[12.5px] font-medium text-dark-50">Context window</span>
                    <span className={cn("text-[11.5px] tabular-nums", tone)}>{percent}</span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-dark-700">
                    <div
                        className={cn("h-full rounded-full", level?.bar ?? "bg-dark-200")}
                        style={{ width: `${(fraction ?? 0) * 100}%` }}
                    />
                </div>
                <span className="text-[11px] text-dark-250 tabular-nums">{counts}</span>
            </div>
            <button
                type="button"
                disabled={!!compact.disabled}
                onClick={() => {
                    setOpen(false);
                    compact.run();
                }}
                className={cn(cardActionClassName, "disabled:pointer-events-none disabled:text-dark-250")}
            >
                <ArrowsInLineVerticalIcon className="size-3.5" />
                <span className="flex-1">Compact context</span>
            </button>
            {compact.disabled && <p className="px-3 pb-2 text-[11px] text-dark-250">{compact.disabled}</p>}
        </ChipPopover>
    );
}
