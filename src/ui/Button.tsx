import type { ComponentProps, ReactNode } from "react";
import { Button as BaseButton } from "@base-ui/react/button";
import { cn } from "@/lib/cn";
import { CircleNotchIcon } from "@phosphor-icons/react";

const variantStyles = {
    default: "bg-raised text-text hover:bg-hover active:bg-border",
    primary:
        "bg-accent text-accent-fg hover:bg-accent/90 active:bg-accent/80",
    ghost: "bg-transparent text-text hover:bg-hover active:bg-hover",
    destructive:
        "bg-danger/15 text-danger hover:bg-danger/25 active:bg-danger/35"
} as const;

const sizeStyles = {
    sm: "h-6 px-2.5 text-xs gap-1",
    md: "h-8 px-3.5 text-sm gap-2"
} as const;

type ButtonProps = ComponentProps<typeof BaseButton> & {
    variant?: keyof typeof variantStyles;
    size?: keyof typeof sizeStyles;
    /** Disables the button and puts a spinner in `leftIcon`'s place. */
    loading?: boolean;
    leftIcon?: ReactNode;
    className?: string;
};

export function Button({
    variant = "default",
    size = "md",
    disabled = false,
    loading = false,
    children,
    leftIcon,
    className,
    ...props
}: ButtonProps) {
    return (
        <BaseButton
            className={cn(
                "inline-flex items-center justify-center font-medium transition-colors rounded-md",
                "active:scale-[0.98]",
                "data-[disabled]:opacity-50 data-[disabled]:active:scale-100 data-[disabled]:pointer-events-none",
                variantStyles[variant],
                sizeStyles[size],
                className
            )}
            disabled={disabled || loading}
            {...props}
        >
            {loading ? (
                <CircleNotchIcon className="size-3 animate-spin" weight="bold" />
            ) : (
                leftIcon && <span className="-ml-0.5 inline-flex shrink-0">{leftIcon}</span>
            )}
            {children}
        </BaseButton>
    );
}
