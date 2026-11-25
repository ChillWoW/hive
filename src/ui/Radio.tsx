import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { RadioGroup as RadioGroupPrimitive } from "@base-ui/react/radio-group";
import { cn } from "@/lib/cn";

const sizes = {
    xs: { root: "size-3", dot: "size-1" },
    sm: { root: "size-3.5", dot: "size-1.5" },
    md: { root: "size-4", dot: "size-1.5" },
    lg: { root: "size-5", dot: "size-2" },
    xl: { root: "size-6", dot: "size-2.5" },
} as const;

export type RadioSize = keyof typeof sizes;

export interface RadioProps<Value = unknown> extends RadioPrimitive.Root.Props<Value> {
    size?: RadioSize;
}

/**
 * Single choice within `Radio.Group`; `value` identifies it. Label it by wrapping it in
 * a `<label>`, or pass `aria-label`.
 */
export function Radio<Value>({ size = "md", className, ...props }: RadioProps<Value>) {
    return (
        <RadioPrimitive.Root
            data-slot="radio"
            className={(state) =>
                cn(
                    "inline-flex shrink-0 cursor-pointer items-center justify-center rounded-full border border-border bg-transparent",
                    "transition-[background-color,border-color] duration-150 ease-out",
                    "hover:border-muted",
                    "data-checked:border-accent data-checked:bg-accent",
                    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
                    "data-invalid:border-danger",
                    "data-readonly:cursor-default data-readonly:hover:border-border data-readonly:data-checked:hover:border-accent",
                    "data-disabled:cursor-not-allowed data-disabled:opacity-50 data-disabled:hover:border-border data-disabled:data-checked:hover:border-accent",
                    sizes[size].root,
                    typeof className === "function" ? className(state) : className,
                )
            }
            {...props}
        >
            <RadioPrimitive.Indicator
                data-slot="radio-indicator"
                className={cn(
                    "block rounded-full bg-accent-fg transition-[scale,opacity] duration-150 ease-out motion-reduce:transition-none",
                    "data-starting-style:scale-0 data-starting-style:opacity-0 data-ending-style:scale-0 data-ending-style:opacity-0",
                    sizes[size].dot,
                )}
            />
        </RadioPrimitive.Root>
    );
}

/** Shares the selected value between radios; arrow keys move the selection. */
function RadioGroup<Value>({ className, ...props }: RadioGroupPrimitive.Props<Value>) {
    return (
        <RadioGroupPrimitive
            data-slot="radio-group"
            className={(state) =>
                cn("flex flex-col gap-2", typeof className === "function" ? className(state) : className)
            }
            {...props}
        />
    );
}

Radio.Group = RadioGroup;
