import type { ComponentProps, ReactNode } from "react";
import type { ShortcutRef } from "@/keybindings/runtime";
import { cn } from "@/lib/cn";
import { Tooltip, type TooltipContentProps } from "./Tooltip";

/**
 * The square icon-only button the chrome is full of — the top bar's toggles,
 * window controls, panel and modal headers, row actions. One recipe, so a
 * button in one bar hovers, presses and dims exactly like its neighbour in the
 * next. The glyph is the caller's (`size-3.5`, or `size-4` in the top bar).
 */
export const iconButtonClassName = cn(
    "inline-flex size-6 shrink-0 items-center justify-center rounded-md text-dark-200 outline-none",
    "transition-colors duration-150",
    "hover:bg-dark-700 hover:text-dark-50 active:bg-dark-600",
    "focus-visible:bg-dark-700 focus-visible:text-dark-50",
    "data-[popup-open]:bg-dark-700 data-[popup-open]:text-dark-50",
    "disabled:pointer-events-none disabled:opacity-50"
);

export type IconButtonProps = Omit<ComponentProps<"button">, "aria-label"> & {
    /** The button's accessible name, and its tooltip unless `tooltip` says otherwise. */
    label: string;
    tooltip?: ReactNode;
    /** Where the tooltip opens; below by default. */
    side?: TooltipContentProps["side"];
    /** An action id (or fixed combo) shown in the tooltip. */
    shortcut?: ShortcutRef;
};

/** The square icon-only button (`iconButtonClassName`) with its label as a tooltip. */
export function IconButton({
    label,
    tooltip = label,
    side = "bottom",
    shortcut,
    className,
    ...props
}: IconButtonProps) {
    return (
        <Tooltip>
            <Tooltip.Trigger
                render={
                    <button
                        type="button"
                        aria-label={label}
                        className={cn(iconButtonClassName, className)}
                        {...props}
                    />
                }
            />
            <Tooltip.Content side={side} shortcut={shortcut}>
                {tooltip}
            </Tooltip.Content>
        </Tooltip>
    );
}
