import type { ComponentProps, ReactNode } from "react";
import { Input as BaseInput } from "@base-ui/react/input";
import { cn } from "@/lib/cn";

type Size = "sm" | "md" | "lg";

const wrapperSizeStyles: Record<Size, string> = {
    sm: "h-6 gap-1 px-2 text-xs",
    md: "h-8 gap-2 px-2.5 text-sm",
    lg: "h-10 gap-2.5 px-3 text-sm"
};

const inputSizeStyles: Record<Size, string> = {
    sm: "h-6 px-2 text-xs",
    md: "h-8 px-2.5 text-sm",
    lg: "h-10 px-3 text-sm"
};

export interface InputProps extends Omit<ComponentProps<typeof BaseInput>, "className" | "size"> {
    size?: Size;
    /** Inside the field's border, after the text (a show/hide or browse button). */
    rightIcon?: ReactNode;
    invalid?: boolean;
    className?: string;
    /** The bordered shell's classes, when there is a `rightIcon`. */
    wrapperClassName?: string;
}

const baseSurface = [
    "bg-dark-700 text-dark-50",
    "border border-dark-500",
    "transition-[background-color,border-color,color]",
    "hover:border-dark-400",
    "data-[invalid]:border-danger aria-invalid:border-danger",
    "data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
    "disabled:pointer-events-none disabled:opacity-50"
].join(" ");

export function Input({
    size = "md",
    rightIcon,
    invalid,
    disabled,
    className,
    wrapperClassName,
    ...props
}: InputProps) {
    if (!rightIcon) {
        return (
            <BaseInput
                disabled={disabled}
                aria-invalid={invalid || undefined}
                className={cn(
                    "block w-full rounded-md",
                    baseSurface,
                    "placeholder:text-dark-200",
                    "focus:border-dark-400 data-[focused]:border-dark-400",
                    "data-[invalid]:focus:border-danger",
                    "disabled:cursor-not-allowed",
                    inputSizeStyles[size],
                    className
                )}
                {...props}
            />
        );
    }

    return (
        <div
            data-disabled={disabled || undefined}
            data-invalid={invalid || undefined}
            className={cn(
                "group relative inline-flex w-full items-center rounded-md",
                baseSurface,
                "focus-within:border-dark-400",
                "data-[invalid]:focus-within:border-danger",
                wrapperSizeStyles[size],
                wrapperClassName
            )}
        >
            <BaseInput
                disabled={disabled}
                aria-invalid={invalid || undefined}
                className={cn(
                    "min-w-0 flex-1 bg-transparent text-dark-50 outline-none",
                    "placeholder:text-dark-200",
                    "disabled:cursor-not-allowed",
                    className
                )}
                {...props}
            />
            <span className="-mr-0.5 inline-flex shrink-0 items-center justify-center text-dark-200">
                {rightIcon}
            </span>
        </div>
    );
}
