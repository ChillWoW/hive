import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox";
import { CheckboxGroup as CheckboxGroupPrimitive } from "@base-ui/react/checkbox-group";
import { CheckIcon, MinusIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/cn";

const sizes = {
    xs: { root: "size-3 rounded-[3px]", icon: "size-2.5" },
    sm: { root: "size-3.5 rounded-[3px]", icon: "size-2.5" },
    md: { root: "size-4 rounded-sm", icon: "size-3" },
    lg: { root: "size-5 rounded-[5px]", icon: "size-3.5" },
    xl: { root: "size-6 rounded-md", icon: "size-4" },
} as const;

export type CheckboxSize = keyof typeof sizes;

export interface CheckboxProps extends CheckboxPrimitive.Root.Props {
    size?: CheckboxSize;
}

/**
 * Tickable box with checked, unchecked and indeterminate states. Label it by wrapping
 * it in a `<label>` or `Field.Label`, or pass `aria-label`. Inside `Checkbox.Group`,
 * `value` identifies it; `parent` makes it toggle the whole group.
 */
export function Checkbox({ size = "md", className, ...props }: CheckboxProps) {
    return (
        <CheckboxPrimitive.Root
            data-slot="checkbox"
            className={(state) =>
                cn(
                    "inline-flex shrink-0 cursor-pointer items-center justify-center border border-border bg-transparent text-accent-fg",
                    "transition-[background-color,border-color] duration-150 ease-out",
                    "hover:border-muted",
                    "data-checked:border-accent data-checked:bg-accent data-indeterminate:border-accent data-indeterminate:bg-accent",
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
            <CheckboxPrimitive.Indicator
                data-slot="checkbox-indicator"
                className={cn(
                    "flex items-center justify-center transition-[scale,opacity] duration-150 ease-out motion-reduce:transition-none",
                    "data-starting-style:scale-50 data-starting-style:opacity-0 data-ending-style:scale-50 data-ending-style:opacity-0",
                )}
            >
                <CheckIcon weight="bold" className={cn(sizes[size].icon, "in-data-indeterminate:hidden")} />
                <MinusIcon weight="bold" className={cn(sizes[size].icon, "hidden in-data-indeterminate:block")} />
            </CheckboxPrimitive.Indicator>
        </CheckboxPrimitive.Root>
    );
}

/** Shares checked state between checkboxes; `value` lists the ticked checkboxes' values. */
function CheckboxGroup({ className, ...props }: CheckboxGroupPrimitive.Props) {
    return (
        <CheckboxGroupPrimitive
            data-slot="checkbox-group"
            className={(state) =>
                cn("flex flex-col gap-2", typeof className === "function" ? className(state) : className)
            }
            {...props}
        />
    );
}

Checkbox.Group = CheckboxGroup;
