import { NumberField as NumberFieldPrimitive } from "@base-ui/react/number-field";
import { ArrowsHorizontalIcon, MinusIcon, PlusIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/cn";

// Heights match Input and Button sizes (28-44) so they line up in a row.
// Stepper buttons are square: their width equals the group height.
const sizes = {
    xs: { group: "h-7 text-xs", button: "w-7 [&_svg]:size-3" },
    sm: { group: "h-8 text-sm", button: "w-8 [&_svg]:size-3.5" },
    md: { group: "h-9 text-sm", button: "w-9 [&_svg]:size-4" },
    lg: { group: "h-10 text-sm", button: "w-10 [&_svg]:size-4" },
    xl: { group: "h-11 text-base", button: "w-11 [&_svg]:size-4.5" },
} as const;

export type NumberFieldSize = keyof typeof sizes;

export interface NumberFieldProps extends NumberFieldPrimitive.Root.Props {
    size?: NumberFieldSize;
    placeholder?: string;
}

// The group already dims when disabled, so a disabled stepper inside it doesn't dim again.
const stepperClass = cn(
    "flex h-full shrink-0 cursor-pointer select-none items-center justify-center text-muted outline-none",
    "transition-[background-color,color] duration-150 ease-out",
    "hover:bg-raised hover:text-text focus-visible:bg-raised focus-visible:text-text",
    "data-disabled:cursor-not-allowed data-disabled:hover:bg-transparent data-disabled:hover:text-muted",
    "group-not-data-disabled/number-field:data-disabled:opacity-50",
    "data-readonly:cursor-default data-readonly:opacity-100",
);

/**
 * Numeric input with decrement/increment buttons; arrow keys step by `step`
 * (Shift: `largeStep`, Alt: `smallStep`) and `format` takes `Intl.NumberFormat` options.
 * `aria-label` and `placeholder` go to the input. `children` render above the control,
 * e.g. a `NumberField.ScrubArea` label. Label it with `Field.Label` or `aria-label`.
 */
export function NumberField({
    size = "sm",
    placeholder,
    "aria-label": ariaLabel,
    "aria-labelledby": ariaLabelledBy,
    className,
    children,
    ...props
}: NumberFieldProps) {
    return (
        <NumberFieldPrimitive.Root
            data-slot="number-field"
            className={(state) =>
                cn(
                    "flex w-full min-w-0 flex-col items-start gap-1.5",
                    typeof className === "function" ? className(state) : className,
                )
            }
            {...props}
        >
            {children}
            <NumberFieldPrimitive.Group
                data-slot="number-field-group"
                className={cn(
                    "group/number-field flex w-full min-w-0 overflow-hidden rounded-md border border-border text-text transition-[border-color] duration-150 ease-out",
                    "has-[input:focus-visible]:border-muted",
                    "data-invalid:border-danger data-invalid:has-[input:focus-visible]:border-danger",
                    "data-disabled:cursor-not-allowed data-disabled:opacity-50",
                    sizes[size].group,
                )}
            >
                <NumberFieldPrimitive.Decrement
                    data-slot="number-field-decrement"
                    aria-label="Decrease"
                    className={cn(stepperClass, "border-r border-border", sizes[size].button)}
                >
                    <MinusIcon />
                </NumberFieldPrimitive.Decrement>
                <NumberFieldPrimitive.Input
                    data-slot="number-field-input"
                    placeholder={placeholder}
                    aria-label={ariaLabel}
                    aria-labelledby={ariaLabelledBy}
                    className={cn(
                        "h-full w-full min-w-0 flex-1 bg-transparent px-2 text-center tabular-nums outline-none",
                        "placeholder:text-muted selection:bg-accent selection:text-accent-fg",
                        "data-disabled:cursor-not-allowed",
                    )}
                />
                <NumberFieldPrimitive.Increment
                    data-slot="number-field-increment"
                    aria-label="Increase"
                    className={cn(stepperClass, "border-l border-border", sizes[size].button)}
                >
                    <PlusIcon />
                </NumberFieldPrimitive.Increment>
            </NumberFieldPrimitive.Group>
        </NumberFieldPrimitive.Root>
    );
}

/**
 * Drag horizontally over this area (usually wrapping the label) to scrub the value.
 * Put it in `NumberField`'s children. Shows a custom cursor while dragging (not in Safari).
 */
function NumberFieldScrubArea({ className, children, ...props }: NumberFieldPrimitive.ScrubArea.Props) {
    return (
        <NumberFieldPrimitive.ScrubArea
            data-slot="number-field-scrub-area"
            className={(state) =>
                cn(
                    "cursor-ew-resize select-none text-sm font-medium text-text [&_label]:cursor-[inherit]",
                    "data-disabled:cursor-not-allowed data-disabled:opacity-50 data-readonly:cursor-default",
                    typeof className === "function" ? className(state) : className,
                )
            }
            {...props}
        >
            {children}
            <NumberFieldPrimitive.ScrubAreaCursor className="text-text drop-shadow-[0_1px_1px_var(--color-black)]">
                <ArrowsHorizontalIcon weight="bold" className="size-5" />
            </NumberFieldPrimitive.ScrubAreaCursor>
        </NumberFieldPrimitive.ScrubArea>
    );
}

NumberField.ScrubArea = NumberFieldScrubArea;
