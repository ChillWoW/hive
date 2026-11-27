import { useState } from "react";
import { Popover } from "@base-ui/react/popover";
import { ArrowsInLineVerticalIcon } from "@phosphor-icons/react";
import type { ContextWindow } from "@/proto";
import { cn } from "@/lib/cn";
import { formatTokens } from "@/lib/format";
import { Ring, Tooltip } from "@/ui";
import { cardFooterButtonClassName, cardFooterClassName, chipClassName, chipTriggerClassName, popupClassName } from "@/ui/chip";

/** `/compact` from the meter's card. */
export type CompactAction = { run: () => void; disabled?: boolean };

/** The ring's tone and the card's bar, by how full the window is. */
const LEVELS = [
    { from: 0.9, text: "text-danger", bar: "bg-danger", held: "hover:text-danger data-[popup-open]:text-danger" },
    { from: 0.7, text: "text-warning", bar: "bg-warning", held: "hover:text-warning data-[popup-open]:text-warning" },
    // The neutral one lifts to the text colour, as every chip does.
    { from: 0, text: "text-muted", bar: "bg-accent", held: "" }
];

/**
 * How full the chat's context window is, as a ring under the composer:
 * amber past 70%, red past 90%, the numbers in its tooltip. Given `compact`
 * (the chat's agent has `/compact`) it opens a card instead: the window as
 * a bar, the numbers, and a button that compacts. `autoCompactAt` is where
 * the agent compacts by itself: a tick on the bar and a line under it.
 */
export function ContextMeter({
    context,
    compact,
    autoCompactAt
}: {
    context: ContextWindow | undefined;
    compact?: CompactAction;
    /** Where the agent compacts by itself, in tokens, when the user set it (Claude). */
    autoCompactAt?: number;
}) {
    const [open, setOpen] = useState(false);
    if (context?.tokens === undefined || !context.window) return null;
    const { tokens, window: capacity } = context;
    const fraction = Math.min(tokens / capacity, 1);
    const percent = Math.round(fraction * 100);
    const level = LEVELS.find((l) => fraction > l.from) ?? LEVELS[2]!;
    const counts = `${formatTokens(tokens)} of ${formatTokens(capacity)} tokens`;
    const auto = autoCompactAt && autoCompactAt < capacity ? autoCompactAt : undefined;
    const label = `Context ${percent}% full`;
    const chip = (
        <>
            <Ring fraction={fraction} />
            <span aria-hidden>{percent}%</span>
        </>
    );

    if (!compact) {
        return (
            <Tooltip>
                <Tooltip.Trigger
                    render={
                        <span
                            role="img"
                            aria-label={label}
                            className={cn(chipClassName, "shrink-0 gap-1 px-1 tabular-nums", level.text)}
                        >
                            {chip}
                        </span>
                    }
                />
                <Tooltip.Content side="top" align="end">
                    <span className="flex flex-col tabular-nums">
                        <span>
                            {label} · {counts}
                        </span>
                        {auto && <span className="text-muted">Compacts by itself near {formatTokens(auto)}</span>}
                    </span>
                </Tooltip.Content>
            </Tooltip>
        );
    }

    return (
        <Popover.Root open={open} onOpenChange={setOpen}>
            <Popover.Trigger
                aria-label={label}
                className={cn(
                    chipTriggerClassName,
                    "shrink-0 gap-1 px-1.5 tabular-nums",
                    level.text,
                    level.held
                )}
            >
                {chip}
            </Popover.Trigger>
            <Popover.Portal>
                <Popover.Positioner side="top" align="end" sideOffset={8} collisionPadding={12}>
                    <Popover.Popup aria-label="Context window" className={cn(popupClassName, "w-72 p-1")}>
                        <div className="flex flex-col gap-2 px-2 pt-1.5 pb-2">
                            <div className="flex items-baseline justify-between gap-2">
                                <span className="text-xs font-medium text-text">Context window</span>
                                <span className={cn("text-xs tabular-nums", level.text)}>{percent}%</span>
                            </div>
                            <div className="relative h-1.5 rounded-full bg-border">
                                <div
                                    className={cn(
                                        "h-full min-w-1.5 rounded-full transition-[width] duration-300 ease-out",
                                        level.bar
                                    )}
                                    style={{ width: `${fraction * 100}%` }}
                                />
                                {auto && (
                                    // Where it compacts by itself: a notch through the bar.
                                    <span
                                        aria-hidden
                                        className="absolute -inset-y-1 w-0.5 -translate-x-1/2 rounded-full bg-accent"
                                        style={{ left: `${(auto / capacity) * 100}%` }}
                                    />
                                )}
                            </div>
                            <div className="flex flex-col gap-0.5 text-[11px] text-muted tabular-nums">
                                <span>{counts}</span>
                                {auto && (
                                    <span>
                                        {tokens >= auto
                                            ? "Compacts by itself on the next turn"
                                            : `Compacts by itself near ${formatTokens(auto)}, ${formatTokens(auto - tokens)} from now`}
                                    </span>
                                )}
                            </div>
                        </div>
                        <div className={cardFooterClassName}>
                            <button
                                type="button"
                                disabled={compact.disabled}
                                onClick={() => {
                                    setOpen(false);
                                    compact.run();
                                }}
                                className={cardFooterButtonClassName}
                            >
                                <ArrowsInLineVerticalIcon className="size-3.5 shrink-0" />
                                <span className="min-w-0 flex-1 truncate">Compact the conversation</span>
                            </button>
                        </div>
                    </Popover.Popup>
                </Popover.Positioner>
            </Popover.Portal>
        </Popover.Root>
    );
}
