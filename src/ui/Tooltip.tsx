import { createContext, useContext, type ReactElement, type ReactNode } from "react";
import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import { useBinding, type ShortcutRef } from "@/keybindings/runtime";
import { ShortcutKeys } from "@/keybindings/ShortcutKeys";
import { cn } from "@/lib/cn";

interface TriggerOptions {
    /**
     * ms before opening on hover. Falls back to the nearest `Tooltip.Provider` (150 by
     * default; one wraps the app in `main.tsx`), then Base UI's 600.
     */
    delay?: number;
    /** ms before closing after the pointer leaves. Falls back to `Tooltip.Provider`, then 0. */
    closeDelay?: number;
    /** Close the tooltip when the trigger is clicked. Default `false`. */
    closeOnClick?: boolean;
}

// Lets trigger options set on `Tooltip` reach `Tooltip.Trigger` in compound usage.
const TriggerContext = createContext<TriggerOptions>({});

export interface TooltipProps
    extends TooltipPrimitive.Root.Props,
        TriggerOptions,
        Pick<TooltipContentProps, "side" | "align" | "sideOffset" | "arrow" | "shortcut"> {
    /**
     * Shorthand: renders the single `children` element as the trigger and this as the
     * popup. Positioning props (`side`, `align`, `sideOffset`, `arrow`) only apply here;
     * in compound usage pass them to `Tooltip.Content`.
     */
    content?: ReactNode;
}

/**
 * Shows a short label on hover/focus.
 *
 * Shorthand: `<Tooltip content="Save"><Button /></Tooltip>`.
 * Compound: `Tooltip.Trigger` + `Tooltip.Content` for rich content.
 * Wrap a group in `Tooltip.Provider` so neighbours open instantly once one is open.
 */
export function Tooltip({
    delay,
    closeDelay,
    closeOnClick,
    content,
    side,
    align,
    sideOffset,
    arrow,
    shortcut,
    children,
    ...props
}: TooltipProps) {
    return (
        <TriggerContext value={{ delay, closeDelay, closeOnClick }}>
            <TooltipPrimitive.Root {...props}>
                {content === undefined ? (
                    children
                ) : (
                    <>
                        <TooltipTrigger render={children as ReactElement} />
                        <TooltipContent side={side} align={align} sideOffset={sideOffset} arrow={arrow} shortcut={shortcut}>
                            {content}
                        </TooltipContent>
                    </>
                )}
            </TooltipPrimitive.Root>
        </TriggerContext>
    );
}

/** Renders a `<button>` by default; use `render={<Button />}` to swap in another element. */
function TooltipTrigger({
    delay,
    closeDelay,
    closeOnClick,
    ...props
}: TooltipPrimitive.Trigger.Props) {
    const inherited = useContext(TriggerContext);
    return (
        <TooltipPrimitive.Trigger
            delay={delay ?? inherited.delay}
            closeDelay={closeDelay ?? inherited.closeDelay}
            closeOnClick={closeOnClick ?? inherited.closeOnClick ?? false}
            {...props}
        />
    );
}

export interface TooltipContentProps
    extends TooltipPrimitive.Popup.Props,
        Pick<
            TooltipPrimitive.Positioner.Props,
            "side" | "align" | "sideOffset" | "alignOffset" | "collisionPadding"
        > {
    /** Shows an arrow pointing at the trigger. Default `false`. */
    arrow?: boolean;
    /** Where to portal the popup. Defaults to `document.body`. */
    container?: TooltipPrimitive.Portal.Props["container"];
    /**
     * Shown as muted keys after the label: an action id (its current binding,
     * nothing while unbound) or a fixed combo like `Escape`.
     */
    shortcut?: ShortcutRef;
}

function TooltipShortcut({ shortcut }: { shortcut: ShortcutRef }) {
    const binding = useBinding(shortcut);
    return <ShortcutKeys shortcut={binding} variant="plain" className="shrink-0 text-muted" />;
}

function TooltipContent({
    side = "top",
    align = "center",
    sideOffset,
    alignOffset,
    collisionPadding = 8,
    arrow = false,
    container,
    shortcut,
    className,
    children,
    ...props
}: TooltipContentProps) {
    return (
        <TooltipPrimitive.Portal container={container}>
            <TooltipPrimitive.Positioner
                side={side}
                align={align}
                sideOffset={sideOffset ?? (arrow ? 10 : 6)}
                alignOffset={alignOffset}
                collisionPadding={collisionPadding}
            >
                <TooltipPrimitive.Popup
                    className={(state) =>
                        cn(
                            "relative max-w-xs rounded-md border border-border bg-raised px-2 py-1 text-xs text-text shadow-md shadow-shadow/30",
                            "origin-(--transform-origin) transition-[opacity,scale] duration-150 ease-out",
                            "data-starting-style:scale-95 data-starting-style:opacity-0",
                            "data-ending-style:scale-95 data-ending-style:opacity-0",
                            "data-instant:transition-none",
                            typeof className === "function" ? className(state) : className,
                        )
                    }
                    {...props}
                >
                    {shortcut ? (
                        <span className="flex items-center gap-2">
                            <span className="min-w-0">{children}</span>
                            <TooltipShortcut shortcut={shortcut} />
                        </span>
                    ) : (
                        children
                    )}
                    {arrow && <TooltipArrow />}
                </TooltipPrimitive.Popup>
            </TooltipPrimitive.Positioner>
        </TooltipPrimitive.Portal>
    );
}

/**
 * A bordered square rotated 45° and centred on the popup's edge, clipped to the half
 * that sticks out, so its border joins the popup's border seamlessly.
 */
function TooltipArrow() {
    return (
        <TooltipPrimitive.Arrow
            className={cn(
                "size-2.5 rotate-45 border border-border bg-raised",
                "data-[side=top]:-bottom-1.25 data-[side=top]:[clip-path:polygon(100%_0,100%_100%,0_100%)]",
                "data-[side=bottom]:-top-1.25 data-[side=bottom]:[clip-path:polygon(0_0,100%_0,0_100%)]",
                "data-[side=left]:-right-1.25 data-[side=left]:[clip-path:polygon(0_0,100%_0,100%_100%)]",
                "data-[side=right]:-left-1.25 data-[side=right]:[clip-path:polygon(0_0,100%_100%,0_100%)]",
                // Logical sides (assumes LTR)
                "data-[side=inline-start]:-right-1.25 data-[side=inline-start]:[clip-path:polygon(0_0,100%_0,100%_100%)]",
                "data-[side=inline-end]:-left-1.25 data-[side=inline-end]:[clip-path:polygon(0_0,100%_100%,0_100%)]",
            )}
        />
    );
}

/** Shares delays across the tooltips inside it; once one is open, neighbours open instantly. */
function TooltipProvider({ delay = 150, ...props }: TooltipPrimitive.Provider.Props) {
    return <TooltipPrimitive.Provider delay={delay} {...props} />;
}

Tooltip.Provider = TooltipProvider;
Tooltip.Trigger = TooltipTrigger;
Tooltip.Content = TooltipContent;
