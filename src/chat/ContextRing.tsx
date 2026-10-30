import { useState } from "react";
import { ArrowsInLineVerticalIcon } from "@phosphor-icons/react";
import type { ContextUsage } from "@/proto";
import { cn } from "@/lib/cn";
import { chipClassName, chipTriggerClassName, popupClassName } from "@/composer/chip";
import { Popover, Tooltip, usePortalContainer } from "@/ui";
import { Ring } from "./Ring";

const count = (n: number) => n.toLocaleString("en-US");

/** `/compact` from the ring's card; `disabled` says why it can't run now. */
export type CompactAction = { run: () => void; disabled?: string };

/**
 * How full the chat's context window is, as a ring and percent under the
 * composer (as in zeron): muted, warning from 75%, danger from 90%; the
 * token counts in its tooltip. Nothing until the harness reports a window.
 * With `compact` (the harness has `/compact`) it opens a card instead, with
 * the counts and a Compact context button, as in t3code.
 */
export function ContextRing({
    usage,
    compact
}: {
    usage: ContextUsage | undefined;
    compact?: CompactAction;
}) {
    const container = usePortalContainer();
    const [open, setOpen] = useState(false);
    const capacity = usage?.window;
    if (!capacity) return null;
    const tokens = usage.tokens;
    const fraction = tokens != null ? Math.min(tokens / capacity, 1) : null;
    const tone =
        fraction == null
            ? "text-dark-250"
            : fraction >= 0.9
              ? "text-danger"
              : fraction >= 0.75
                ? "text-warning"
                : "text-dark-200";
    const percent = fraction == null ? "—" : `${Math.round(fraction * 100)}%`;
    const counts =
        tokens != null
            ? `${count(tokens)} / ${count(capacity)} tokens`
            : `${count(capacity)} token window`;

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
                            <Ring fraction={fraction} />
                            {percent}
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
        <Popover open={open} onOpenChange={setOpen}>
            <Popover.Trigger
                aria-label="Context window"
                className={cn(chipTriggerClassName, "shrink-0 gap-1.5 px-1.5 tabular-nums", tone)}
            >
                <Ring fraction={fraction} />
                {percent}
            </Popover.Trigger>
            <Popover.Portal container={container ?? undefined}>
                <Popover.Positioner
                    side="top"
                    align="end"
                    sideOffset={10}
                    collisionPadding={{ top: 48, right: 12, bottom: 12, left: 12 }}
                >
                    <Popover.Popup
                        aria-label="Context window"
                        className={cn(popupClassName, "w-72 min-w-0 rounded-xl p-0")}
                    >
                        <div className="flex flex-col gap-2 px-3 pt-3 pb-2.5">
                            <div className="flex items-baseline justify-between gap-2">
                                <span className="text-[12.5px] font-medium text-dark-50">
                                    Context window
                                </span>
                                <span className={cn("text-[11.5px] tabular-nums", tone)}>
                                    {percent}
                                </span>
                            </div>
                            <div className="h-1.5 overflow-hidden rounded-full bg-dark-700">
                                <div
                                    className={cn(
                                        "h-full rounded-full",
                                        fraction != null && fraction >= 0.9
                                            ? "bg-danger/90"
                                            : fraction != null && fraction >= 0.75
                                              ? "bg-warning/90"
                                              : "bg-dark-200"
                                    )}
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
                            className="flex w-full items-center gap-2 border-t border-dark-700 px-3 py-2 text-left text-[11.5px] text-dark-200 outline-none transition-colors hover:bg-dark-700 hover:text-dark-50 focus-visible:bg-dark-700 disabled:pointer-events-none disabled:text-dark-250"
                        >
                            <ArrowsInLineVerticalIcon className="size-3.5" />
                            <span className="flex-1">Compact context</span>
                        </button>
                        {compact.disabled && (
                            <p className="px-3 pb-2 text-[11px] text-dark-250">{compact.disabled}</p>
                        )}
                    </Popover.Popup>
                </Popover.Positioner>
            </Popover.Portal>
        </Popover>
    );
}
