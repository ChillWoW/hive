import { Switch as SwitchPrimitive } from "@base-ui/react/switch";
import { cn } from "@/lib/cn";

// Track padding is 2px, so the thumb travels (track width - 4px - thumb width), which
// equals track width - track height. While pressed the thumb stretches by 4px (iOS-style),
// so the checked offset shrinks by the same amount to keep it pinned to the right edge.
// The press variant skips disabled and read-only switches, which can't change.
const sizes = {
    xs: {
        root: "h-3.5 w-5",
        thumb: "size-2.5 data-checked:translate-x-1.5 group-[:active:not([data-disabled],[data-readonly])]:w-3.5 group-[:active:not([data-disabled],[data-readonly])]:data-checked:translate-x-0.5",
    },
    sm: {
        root: "h-4 w-6",
        thumb: "size-3 data-checked:translate-x-2 group-[:active:not([data-disabled],[data-readonly])]:w-4 group-[:active:not([data-disabled],[data-readonly])]:data-checked:translate-x-1",
    },
    md: {
        root: "h-5 w-8",
        thumb: "size-4 data-checked:translate-x-3 group-[:active:not([data-disabled],[data-readonly])]:w-5 group-[:active:not([data-disabled],[data-readonly])]:data-checked:translate-x-2",
    },
    lg: {
        root: "h-6 w-10",
        thumb: "size-5 data-checked:translate-x-4 group-[:active:not([data-disabled],[data-readonly])]:w-6 group-[:active:not([data-disabled],[data-readonly])]:data-checked:translate-x-3",
    },
    xl: {
        root: "h-7 w-12",
        thumb: "size-6 data-checked:translate-x-5 group-[:active:not([data-disabled],[data-readonly])]:w-7 group-[:active:not([data-disabled],[data-readonly])]:data-checked:translate-x-4",
    },
} as const;

export type SwitchSize = keyof typeof sizes;

export interface SwitchProps extends SwitchPrimitive.Root.Props {
    size?: SwitchSize;
}

/**
 * On/off toggle. Renders the track and thumb; label it by wrapping it in a `<label>`
 * or `Field.Label`, or pass `aria-label`.
 */
export function Switch({ size = "md", className, ...props }: SwitchProps) {
    return (
        <SwitchPrimitive.Root
            data-slot="switch"
            className={(state) =>
                cn(
                    "group relative inline-flex shrink-0 cursor-pointer items-center rounded-full p-0.5 transition-[background-color] duration-150 ease-out",
                    "bg-hover hover:bg-border data-checked:bg-accent data-checked:hover:bg-accent/85",
                    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
                    "data-invalid:ring-1 data-invalid:ring-danger",
                    "data-readonly:cursor-default data-readonly:hover:bg-hover data-readonly:data-checked:hover:bg-accent",
                    "data-disabled:cursor-not-allowed data-disabled:opacity-50 data-disabled:hover:bg-hover data-disabled:data-checked:hover:bg-accent",
                    sizes[size].root,
                    typeof className === "function" ? className(state) : className,
                )
            }
            {...props}
        >
            <SwitchPrimitive.Thumb
                data-slot="switch-thumb"
                className={cn(
                    "pointer-events-none block rounded-full bg-text shadow-sm shadow-shadow/30 data-checked:bg-accent-fg",
                    "transition-[translate,width,background-color] duration-150 ease-out motion-reduce:transition-none",
                    sizes[size].thumb,
                )}
            />
        </SwitchPrimitive.Root>
    );
}
