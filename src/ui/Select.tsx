import { createContext, use } from "react";
import { Select as SelectPrimitive } from "@base-ui/react/select";
import { CaretDownIcon, CaretUpDownIcon, CaretUpIcon, CheckIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/cn";

type ClassName<State> = string | ((state: State) => string | undefined) | undefined;

function withBase<State>(base: string, className: ClassName<State>) {
    return (state: State) => cn(base, typeof className === "function" ? className(state) : className);
}

// Trigger heights match Input and Button sizes (28-44) so they line up in a row.
const triggerSizes = {
    xs: "h-7 gap-1.5 pr-1.5 pl-2 text-xs [&_svg:not([class*='size-'])]:size-3.5",
    sm: "h-8 gap-2 pr-2 pl-2.5 text-xs [&_svg:not([class*='size-'])]:size-3.5",
    md: "h-9 gap-2 pr-2.5 pl-3 text-[13px] [&_svg:not([class*='size-'])]:size-4",
    lg: "h-10 gap-2 pr-3 pl-3.5 text-sm [&_svg:not([class*='size-'])]:size-4.5",
    xl: "h-11 gap-2.5 pr-3.5 pl-4 text-base [&_svg:not([class*='size-'])]:size-5",
} as const;

export type SelectSize = keyof typeof triggerSizes;

// The trigger's size also scales the items, so popup text matches the trigger text.
const SizeContext = createContext<SelectSize>("sm");

const itemSizes = {
    xs: "py-1 text-xs",
    sm: "py-1.5 text-xs",
    md: "py-1.5 text-[13px]",
    lg: "py-2 text-sm",
    xl: "py-2 text-base",
} as const;

export interface SelectProps<Value, Multiple extends boolean | undefined = false>
    extends SelectPrimitive.Root.Props<Value, Multiple> {
    /** Size of the trigger and items. */
    size?: SelectSize;
}

/**
 * Pick one value (or several with `multiple`) from a popup list. Compose with
 * `Select.Trigger` (holding `Select.Value`) and `Select.Content` (holding `Select.Item`s).
 * Pass `items` so `Select.Value` shows the selected item's label instead of its raw value.
 * Label it with `Field.Label` or `aria-label` on the trigger.
 */
export function Select<Value, Multiple extends boolean | undefined = false>({
    size = "sm",
    ...props
}: SelectProps<Value, Multiple>) {
    return (
        <SizeContext value={size}>
            <SelectPrimitive.Root {...props} />
        </SizeContext>
    );
}

/** The button that opens the popup. Put a `Select.Value` inside; a caret is appended. */
function SelectTrigger({ className, children, ...props }: SelectPrimitive.Trigger.Props) {
    const size = use(SizeContext);
    return (
        <SelectPrimitive.Trigger
            data-slot="select-trigger"
            className={withBase(
                cn(
                    "flex w-full min-w-0 cursor-pointer items-center justify-between rounded-md border border-border bg-transparent text-left text-text outline-none select-none transition-[border-color] duration-150 ease-out",
                    "focus-visible:border-muted data-popup-open:border-muted",
                    "aria-invalid:border-danger data-invalid:border-danger",
                    "data-disabled:cursor-not-allowed data-disabled:opacity-50",
                    "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='text-'])]:text-muted",
                    triggerSizes[size],
                ),
                className,
            )}
            {...props}
        >
            {children}
            <SelectPrimitive.Icon className="flex">
                <CaretUpDownIcon />
            </SelectPrimitive.Icon>
        </SelectPrimitive.Trigger>
    );
}

/** The selected item's label, or `placeholder` (muted) when nothing is selected. */
function SelectValue({ className, ...props }: SelectPrimitive.Value.Props) {
    return (
        <SelectPrimitive.Value
            className={withBase("flex-1 truncate data-placeholder:text-muted", className)}
            {...props}
        />
    );
}

export interface SelectContentProps
    extends SelectPrimitive.Popup.Props,
        Pick<
            SelectPrimitive.Positioner.Props,
            "side" | "align" | "sideOffset" | "alignOffset" | "collisionPadding" | "alignItemWithTrigger"
        > {
    /** Where to portal the popup. Defaults to `document.body`. */
    container?: SelectPrimitive.Portal.Props["container"];
}

/**
 * The popup. Opens below the trigger (flipping when there's no room). `alignItemWithTrigger`
 * instead overlaps the trigger so the selected item lines up with the value (mouse only).
 */
function SelectContent({
    side,
    align = "start",
    sideOffset = 4,
    alignOffset,
    collisionPadding = 8,
    alignItemWithTrigger = false,
    container,
    className,
    children,
    ...props
}: SelectContentProps) {
    return (
        <SelectPrimitive.Portal container={container}>
            <SelectPrimitive.Positioner
                side={side}
                align={align}
                sideOffset={sideOffset}
                alignOffset={alignOffset}
                collisionPadding={collisionPadding}
                alignItemWithTrigger={alignItemWithTrigger}
                className="outline-none select-none"
            >
                <SelectPrimitive.Popup
                    className={withBase(
                        cn(
                            "relative flex max-h-(--available-height) min-w-(--anchor-width) flex-col overflow-hidden rounded-md border border-border bg-raised text-text shadow-lg shadow-black/40 outline-none",
                            "origin-(--transform-origin) transition-[opacity,scale] duration-150 ease-out",
                            "data-starting-style:scale-95 data-starting-style:opacity-0",
                            "data-ending-style:scale-95 data-ending-style:opacity-0",
                            // Aligned with the trigger, it fades in place instead of growing from an edge.
                            "data-[side=none]:data-starting-style:scale-100 data-[side=none]:data-ending-style:scale-100",
                        ),
                        className,
                    )}
                    {...props}
                >
                    <SelectScrollArrow direction="up" />
                    <SelectPrimitive.List className="min-h-0 flex-1 scroll-py-6 overflow-y-auto p-1">
                        {children}
                    </SelectPrimitive.List>
                    <SelectScrollArrow direction="down" />
                </SelectPrimitive.Popup>
            </SelectPrimitive.Positioner>
        </SelectPrimitive.Portal>
    );
}

// Shown at the edges when the list overflows; hovering scrolls it.
function SelectScrollArrow({ direction }: { direction: "up" | "down" }) {
    const Arrow = direction === "up" ? SelectPrimitive.ScrollUpArrow : SelectPrimitive.ScrollDownArrow;
    return (
        <Arrow
            className={cn(
                "absolute inset-x-0 z-10 flex h-6 cursor-default items-center justify-center bg-raised text-muted",
                direction === "up" ? "top-0" : "bottom-0",
            )}
        >
            {direction === "up" ? <CaretUpIcon className="size-3.5" /> : <CaretDownIcon className="size-3.5" />}
        </Arrow>
    );
}

function SelectItem({ className, children, ...props }: SelectPrimitive.Item.Props) {
    const size = use(SizeContext);
    return (
        <SelectPrimitive.Item
            className={withBase(
                cn(
                    "relative flex cursor-pointer items-center gap-2 rounded-sm pr-8 pl-2.5 text-text outline-none select-none",
                    "data-highlighted:bg-hover data-disabled:pointer-events-none data-disabled:opacity-50",
                    "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5 [&_svg:not([class*='text-'])]:text-muted",
                    itemSizes[size],
                ),
                className,
            )}
            {...props}
        >
            <SelectPrimitive.ItemText className="flex min-w-0 flex-1 items-center gap-2 truncate">
                {children}
            </SelectPrimitive.ItemText>
            <SelectPrimitive.ItemIndicator className="absolute right-2 flex size-4 items-center justify-center">
                <CheckIcon weight="bold" className="size-3.5 text-text" />
            </SelectPrimitive.ItemIndicator>
        </SelectPrimitive.Item>
    );
}

/** Heading for a group. Must be inside `Select.Group`. */
function SelectLabel({ className, ...props }: SelectPrimitive.GroupLabel.Props) {
    return (
        <SelectPrimitive.GroupLabel
            className={withBase("px-2.5 py-1 text-[11px] font-medium text-muted select-none", className)}
            {...props}
        />
    );
}

function SelectSeparator({ className, ...props }: SelectPrimitive.Separator.Props) {
    return (
        <SelectPrimitive.Separator className={withBase("-mx-1 my-1 h-px bg-border", className)} {...props} />
    );
}

Select.Trigger = SelectTrigger;
Select.Value = SelectValue;
Select.Content = SelectContent;
Select.Item = SelectItem;
Select.Group = SelectPrimitive.Group;
Select.Label = SelectLabel;
Select.Separator = SelectSeparator;
