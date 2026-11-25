import { Field as FieldPrimitive } from "@base-ui/react/field";
import { cn } from "@/lib/cn";

export type FieldProps = FieldPrimitive.Root.Props;

/**
 * Wraps a control (e.g. `Input`) with its label, description and error, wiring up
 * ids, `aria-*` attributes and validation. Parts render in DOM order.
 */
export function Field({ className, ...props }: FieldProps) {
    return (
        <FieldPrimitive.Root
            className={(state) =>
                cn(
                    "flex w-full min-w-0 flex-col gap-1.5",
                    typeof className === "function" ? className(state) : className,
                )
            }
            {...props}
        />
    );
}

function FieldLabel({ className, ...props }: FieldPrimitive.Label.Props) {
    return (
        <FieldPrimitive.Label
            className={(state) =>
                cn(
                    "w-fit select-none text-sm font-medium text-text",
                    "data-disabled:cursor-not-allowed data-disabled:opacity-50",
                    typeof className === "function" ? className(state) : className,
                )
            }
            {...props}
        />
    );
}

function FieldDescription({ className, ...props }: FieldPrimitive.Description.Props) {
    return (
        <FieldPrimitive.Description
            className={(state) =>
                cn(
                    "text-xs text-muted data-disabled:opacity-50",
                    typeof className === "function" ? className(state) : className,
                )
            }
            {...props}
        />
    );
}

/**
 * Shown while the field is invalid. Without children it shows the browser's
 * validation message; `match` narrows it to one ValidityState key (or `true` to always show).
 */
function FieldError({ className, ...props }: FieldPrimitive.Error.Props) {
    return (
        <FieldPrimitive.Error
            className={(state) =>
                cn(
                    "text-xs text-danger transition-opacity duration-150 ease-out",
                    "data-starting-style:opacity-0 data-ending-style:opacity-0",
                    typeof className === "function" ? className(state) : className,
                )
            }
            {...props}
        />
    );
}

Field.Label = FieldLabel;
Field.Description = FieldDescription;
Field.Error = FieldError;
