import { createContext, useContext } from "react";
import { Toggle as TogglePrimitive } from "@base-ui/react/toggle";
import { ToggleGroup as ToggleGroupPrimitive } from "@base-ui/react/toggle-group";
import { cn } from "@/lib/cn";

const variants = {
    default:
        "bg-transparent text-muted hover:bg-raised hover:text-text data-pressed:bg-hover data-pressed:text-text",
    outline:
        "border border-border bg-transparent text-muted hover:bg-raised hover:text-text data-pressed:bg-raised data-pressed:text-text",
} as const;

// Same height scale as Button (28-44).
const sizes = {
    xs: "h-7 gap-1 px-2 text-xs [&_svg:not([class*='size-'])]:size-3.5",
    sm: "h-8 gap-1.5 px-2.5 text-sm [&_svg:not([class*='size-'])]:size-4",
    md: "h-9 gap-2 px-3 text-sm [&_svg:not([class*='size-'])]:size-4",
    lg: "h-10 gap-2 px-4 text-sm [&_svg:not([class*='size-'])]:size-4.5",
    xl: "h-11 gap-2 px-5 text-base [&_svg:not([class*='size-'])]:size-5",
    "icon-xs": "size-7 [&_svg:not([class*='size-'])]:size-3.5",
    "icon-sm": "size-8 [&_svg:not([class*='size-'])]:size-4",
    "icon-md": "size-9 [&_svg:not([class*='size-'])]:size-4",
    "icon-lg": "size-10 [&_svg:not([class*='size-'])]:size-4.5",
    "icon-xl": "size-11 [&_svg:not([class*='size-'])]:size-5",
} as const;

export type ToggleVariant = keyof typeof variants;
export type ToggleSize = keyof typeof sizes;

interface ToggleStyle {
    variant?: ToggleVariant;
    size?: ToggleSize;
}

const ToggleGroupStyleContext = createContext<ToggleStyle>({});

export interface ToggleProps<Value extends string = string> extends TogglePrimitive.Props<Value>, ToggleStyle {}

/**
 * Two-state button (Base UI's `Toggle`). Control it with `pressed`/`onPressedChange`, or
 * start it pressed with `defaultPressed`. Icon-only toggles need an `aria-label`.
 * Inside `Toggle.Group`, give each one a `value`; variant and size default to the group's.
 */
export function Toggle<Value extends string = string>({ variant, size, className, ...props }: ToggleProps<Value>) {
    const group = useContext(ToggleGroupStyleContext);
    const v = variant ?? group.variant ?? "default";
    const s = size ?? group.size ?? "sm";

    return (
        <TogglePrimitive
            data-slot="toggle"
            className={(state) =>
                cn(
                    "inline-flex shrink-0 cursor-pointer select-none items-center justify-center whitespace-nowrap rounded-md font-medium transition-[color,background-color,border-color,scale] duration-150 ease-out motion-safe:active:scale-97",
                    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
                    "data-disabled:pointer-events-none data-disabled:opacity-50",
                    "[&_svg]:pointer-events-none [&_svg]:shrink-0",
                    variants[v],
                    sizes[s],
                    typeof className === "function" ? className(state) : className,
                )
            }
            {...props}
        />
    );
}

export interface ToggleGroupProps<Value extends string = string> extends ToggleGroupPrimitive.Props<Value>, ToggleStyle {}

/**
 * Set of toggles sharing one value array (Base UI's `ToggleGroup`). Single-select by
 * default; pass `multiple` to allow several. Arrow keys move focus between items.
 * `variant` and `size` apply to every `Toggle` inside unless the item overrides them.
 */
function ToggleGroup<Value extends string = string>({ variant, size, className, ...props }: ToggleGroupProps<Value>) {
    return (
        <ToggleGroupStyleContext.Provider value={{ variant, size }}>
            <ToggleGroupPrimitive
                data-slot="toggle-group"
                className={(state) =>
                    cn(
                        "inline-flex w-fit items-center gap-1 data-[orientation=vertical]:flex-col data-[orientation=vertical]:items-stretch",
                        typeof className === "function" ? className(state) : className,
                    )
                }
                {...props}
            />
        </ToggleGroupStyleContext.Provider>
    );
}

Toggle.Group = ToggleGroup;
