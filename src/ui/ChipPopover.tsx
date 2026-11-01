import type { ReactNode } from "react";
import { chipTriggerClassName, popupClassName } from "./chip";
import { cn } from "@/lib/cn";
import { Popover } from "./Popover";

/**
 * A chip under the composer (the rings, background tasks) opening a card
 * above it, flush with its right end. The card's width is `className`'s.
 */
export function ChipPopover({
    open,
    onOpenChange,
    label,
    triggerLabel = label,
    triggerClassName,
    trigger,
    className,
    children
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** The card's accessible name (and the chip's, unless `triggerLabel`). */
    label: string;
    triggerLabel?: string;
    triggerClassName?: string;
    trigger: ReactNode;
    className: string;
    children: ReactNode;
}) {
    return (
        <Popover open={open} onOpenChange={onOpenChange}>
            <Popover.Trigger
                aria-label={triggerLabel}
                className={cn(chipTriggerClassName, "shrink-0 gap-1.5 px-1.5", triggerClassName)}
            >
                {trigger}
            </Popover.Trigger>
            <Popover.Portal>
                <Popover.Positioner
                    side="top"
                    align="end"
                    sideOffset={10}
                    collisionPadding={{ top: 48, right: 12, bottom: 12, left: 12 }}
                >
                    <Popover.Popup
                        aria-label={label}
                        className={cn(popupClassName, className, "min-w-0 rounded-xl p-0")}
                    >
                        {children}
                    </Popover.Popup>
                </Popover.Positioner>
            </Popover.Portal>
        </Popover>
    );
}

/** A card's last row: an action across its width, under a hairline. */
export const cardActionClassName =
    "flex w-full items-center gap-2 border-t border-dark-700 px-3 py-2 text-left text-[11.5px] text-dark-200 outline-none transition-colors hover:bg-dark-700 hover:text-dark-50 focus-visible:bg-dark-700";
