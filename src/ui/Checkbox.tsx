import type { ComponentProps } from "react";
import { Checkbox as BaseCheckbox } from "@base-ui/react/checkbox";
import { CheckboxGroup } from "@base-ui/react/checkbox-group";
import { CheckIcon, MinusIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/cn";

type CheckboxRootProps = Omit<
    ComponentProps<typeof BaseCheckbox.Root>,
    "className"
> & {
    label?: string;
    className?: string;
    /** On the box itself, where `className` is on the label around it. */
    boxClassName?: string;
};

function CheckboxRoot({
    label,
    className,
    boxClassName,
    id,
    ...props
}: CheckboxRootProps) {
    return (
        <label
            htmlFor={id}
            className={cn(
                "inline-flex items-center gap-2 text-sm text-dark-100 select-none",
                props.disabled && "opacity-50 pointer-events-none",
                className
            )}
        >
            <BaseCheckbox.Root
                id={id}
                className={cn(
                    "flex size-4 items-center justify-center rounded-sm border transition-colors duration-150 ease-out",
                    "border-dark-500 bg-dark-700 hover:border-dark-400",
                    "data-[checked]:border-primary-100 data-[checked]:bg-primary-100",
                    "data-[indeterminate]:border-primary-100 data-[indeterminate]:bg-primary-100",
                    boxClassName
                )}
                {...props}
            >
                <BaseCheckbox.Indicator className="flex text-dark-900 data-[ending-style]:transition-opacity data-[ending-style]:opacity-0">
                    {props.indeterminate ? (
                        <MinusIcon className="size-3" weight="bold" />
                    ) : (
                        <CheckIcon className="size-3" weight="bold" />
                    )}
                </BaseCheckbox.Indicator>
            </BaseCheckbox.Root>
            {label}
        </label>
    );
}

type GroupProps = Omit<
    ComponentProps<typeof CheckboxGroup>,
    "className"
> & {
    label?: string;
    className?: string;
};

function Group({ label, className, children, ...props }: GroupProps) {
    return (
        <div className={cn("flex flex-col gap-1", className)}>
            {label && (
                <span className="mb-1 text-xs font-medium text-dark-100">
                    {label}
                </span>
            )}
            <CheckboxGroup className="flex flex-col gap-2" {...props}>
                {children}
            </CheckboxGroup>
        </div>
    );
}

export const Checkbox = Object.assign(CheckboxRoot, { Group });
