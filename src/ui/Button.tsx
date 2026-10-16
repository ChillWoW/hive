import type { ComponentProps, ReactNode } from "react";
import { Button as BaseButton } from "@base-ui/react/button";
import { cn } from "@/lib/cn";
import { CircleNotchIcon } from "@phosphor-icons/react";

const variantStyles = {
    default: "bg-dark-700 text-dark-50 hover:bg-dark-600 active:bg-dark-500",
    primary:
        "bg-primary-100 text-dark-900 hover:bg-primary-300 active:bg-primary-400",
    ghost: "bg-transparent text-dark-100 hover:bg-dark-700 active:bg-dark-600",
    destructive:
        "bg-danger/15 text-danger hover:bg-danger/25 active:bg-danger/35"
} as const;

const sizeStyles = {
    sm: "h-6 px-2.5 text-xs gap-1",
    md: "h-8 px-3.5 text-sm gap-2",
    lg: "h-10 px-5 text-base gap-2.5"
} as const;

type ButtonProps = ComponentProps<typeof BaseButton> & {
    variant?: keyof typeof variantStyles;
    size?: keyof typeof sizeStyles;
    loading?: boolean;
    leftIcon?: ReactNode;
    rightIcon?: ReactNode;
    className?: string;
};

export function Button({
    variant = "default",
    size = "md",
    disabled = false,
    loading = false,
    children,
    leftIcon,
    rightIcon,
    className,
    ...props
}: ButtonProps) {
    const isDisabled = disabled || loading;

    return (
        <BaseButton
            className={cn(
                "inline-flex items-center justify-center font-medium transition-colors rounded-sm",
                "active:scale-[0.98]",
                "data-[disabled]:opacity-50 data-[disabled]:active:scale-100 data-[disabled]:pointer-events-none",
                variantStyles[variant],
                sizeStyles[size],
                className
            )}
            disabled={isDisabled}
            {...props}
        >
            {loading ? (
                <CircleNotchIcon
                    className="size-3 animate-spin"
                    weight="bold"
                />
            ) : (
                leftIcon && (
                    <span className="-ml-0.5 inline-flex shrink-0">
                        {leftIcon}
                    </span>
                )
            )}
            {children}
            {!loading && rightIcon && (
                <span className="-mr-0.5 inline-flex shrink-0">
                    {rightIcon}
                </span>
            )}
        </BaseButton>
    );
}
