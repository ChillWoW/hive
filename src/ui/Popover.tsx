import type { ComponentProps } from "react";
import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { XIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/cn";
import { Button } from "./Button";

type ClassName<State> = string | ((state: State) => string | undefined) | undefined;

function withBase<State>(base: string, className: ClassName<State>) {
    return (state: State) => cn(base, typeof className === "function" ? className(state) : className);
}

/**
 * Floating panel anchored to a trigger, opened on click (Base UI's `Popover`). Compose with
 * `Popover.Trigger` and `Popover.Content` (optionally holding `Popover.Header` with
 * `Popover.Title`/`Popover.Description`). Pass `openOnHover` to `Popover.Trigger` for hover
 * cards; `modal` locks scroll and outside interaction while open.
 */
export function Popover(props: PopoverPrimitive.Root.Props) {
    return <PopoverPrimitive.Root {...props} />;
}

export interface PopoverContentProps
    extends PopoverPrimitive.Popup.Props,
        Pick<
            PopoverPrimitive.Positioner.Props,
            "side" | "align" | "sideOffset" | "alignOffset" | "collisionPadding"
        > {
    /** Shows an arrow pointing at the trigger. Default `false`. */
    arrow?: boolean;
    /** Renders an X button in the top-right corner. Default `false`. */
    showCloseButton?: boolean;
    /** Where to portal the popup. Defaults to `document.body`. */
    container?: PopoverPrimitive.Portal.Props["container"];
}

/** The popup. Below the trigger and centered by default; `w-72`, override via `className`. */
function PopoverContent({
    side = "bottom",
    align = "center",
    sideOffset,
    alignOffset,
    collisionPadding = 8,
    arrow = false,
    showCloseButton = false,
    container,
    className,
    children,
    ...props
}: PopoverContentProps) {
    return (
        <PopoverPrimitive.Portal container={container}>
            <PopoverPrimitive.Positioner
                side={side}
                align={align}
                sideOffset={sideOffset ?? (arrow ? 10 : 6)}
                alignOffset={alignOffset}
                collisionPadding={collisionPadding}
            >
                <PopoverPrimitive.Popup
                    className={withBase(
                        cn(
                            "relative flex max-h-(--available-height) w-72 max-w-(--available-width) flex-col gap-2 rounded-md border border-border bg-surface p-2 text-sm text-text shadow-lg shadow-shadow/40 outline-none",
                            "origin-(--transform-origin) transition-[opacity,scale] duration-150 ease-out",
                            "data-starting-style:scale-95 data-starting-style:opacity-0",
                            "data-ending-style:scale-95 data-ending-style:opacity-0",
                            // Keep the header text clear of the close button.
                            showCloseButton && "[&_[data-slot=popover-header]]:pr-7",
                        ),
                        className,
                    )}
                    {...props}
                >
                    {children}
                    {showCloseButton && (
                        <PopoverPrimitive.Close
                            render={<Button variant="ghost" size="icon-xs" />}
                            aria-label="Close"
                            className="absolute top-1 right-1 text-muted hover:text-text"
                        >
                            <XIcon />
                        </PopoverPrimitive.Close>
                    )}
                    {arrow && <PopoverArrow />}
                </PopoverPrimitive.Popup>
            </PopoverPrimitive.Positioner>
        </PopoverPrimitive.Portal>
    );
}

/**
 * A bordered square rotated 45° and centred on the popup's edge, clipped to the half
 * that sticks out, so its border joins the popup's border seamlessly.
 */
function PopoverArrow() {
    return (
        <PopoverPrimitive.Arrow
            className={cn(
                "size-2.5 rotate-45 border border-border bg-surface",
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

/** Holds `Popover.Title` and `Popover.Description`. */
function PopoverHeader({ className, ...props }: ComponentProps<"div">) {
    return <div data-slot="popover-header" className={cn("flex flex-col gap-1", className)} {...props} />;
}

/** Labels the popover for screen readers. */
function PopoverTitle({ className, ...props }: PopoverPrimitive.Title.Props) {
    return (
        <PopoverPrimitive.Title
            className={withBase("text-sm leading-tight font-semibold text-text", className)}
            {...props}
        />
    );
}

/** Describes the popover for screen readers. */
function PopoverDescription({ className, ...props }: PopoverPrimitive.Description.Props) {
    return <PopoverPrimitive.Description className={withBase("text-sm text-muted", className)} {...props} />;
}

/** Renders a `<button>` by default; use `render={<Button />}` to swap in another element. */
Popover.Trigger = PopoverPrimitive.Trigger;
Popover.Content = PopoverContent;
Popover.Header = PopoverHeader;
Popover.Title = PopoverTitle;
Popover.Description = PopoverDescription;
/** Closes the popover. Use `render={<Button />}` for a styled button. */
Popover.Close = PopoverPrimitive.Close;
