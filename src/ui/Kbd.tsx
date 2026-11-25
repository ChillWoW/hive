import type { ComponentProps } from "react";
import { cn } from "@/lib/cn";

const sizes = {
    sm: "h-5 min-w-5 px-1 text-[11px] [&_svg:not([class*='size-'])]:size-3",
    md: "h-6 min-w-6 px-1.5 text-xs [&_svg:not([class*='size-'])]:size-3.5",
} as const;

export type KbdSize = keyof typeof sizes;

export interface KbdProps extends ComponentProps<"kbd"> {
    size?: KbdSize;
}

/** A keyboard key, e.g. `<Kbd>Esc</Kbd>`. Accepts text or an icon. */
export function Kbd({ size = "sm", className, ...props }: KbdProps) {
    return (
        <kbd
            data-slot="kbd"
            className={cn(
                "inline-flex shrink-0 select-none items-center justify-center gap-1 rounded border border-border bg-surface font-sans font-medium text-muted",
                "[&_svg]:pointer-events-none [&_svg]:shrink-0",
                sizes[size],
                className,
            )}
            {...props}
        />
    );
}

export type KbdGroupProps = ComponentProps<"kbd">;

/**
 * A key combination: `<Kbd.Group><Kbd>Ctrl</Kbd>+<Kbd>S</Kbd></Kbd.Group>`. Renders a
 * `<kbd>` wrapping the keys, the HTML convention for a combination.
 */
function KbdGroup({ className, ...props }: KbdGroupProps) {
    return (
        <kbd
            data-slot="kbd-group"
            className={cn("inline-flex items-center gap-1 font-sans text-xs text-muted", className)}
            {...props}
        />
    );
}

Kbd.Group = KbdGroup;
