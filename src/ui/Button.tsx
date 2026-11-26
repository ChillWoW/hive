import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cn } from "@/lib/cn";
import { Spinner } from "./Spinner";

const variants = {
    default: "bg-accent text-accent-fg hover:bg-accent/85",
    destructive: "bg-danger text-white hover:bg-danger/85 focus-visible:outline-danger",
    "destructive-outline":
        "border border-transparent bg-transparent text-danger hover:border-danger/50 focus-visible:outline-danger",
    secondary: "bg-raised text-text hover:bg-hover",
    outline: "border border-border bg-transparent text-text hover:bg-raised",
    ghost: "bg-transparent text-text hover:bg-raised",
    link: "bg-transparent text-text underline-offset-4 hover:underline",
} as const;

// Heights step by 4px (28-44). Icons and the loading spinner share one size per step.
const sizes = {
    xs: "h-7 gap-1 px-2.5 text-xs [&_svg:not([class*='size-'])]:size-3.5",
    sm: "h-8 gap-1.5 px-3 text-xs [&_svg:not([class*='size-'])]:size-4",
    md: "h-9 gap-2 px-4 text-[13px] [&_svg:not([class*='size-'])]:size-4",
    lg: "h-10 gap-2 px-5 text-sm [&_svg:not([class*='size-'])]:size-4.5",
    xl: "h-11 gap-2 px-6 text-base [&_svg:not([class*='size-'])]:size-5",
    "icon-xs": "size-7 [&_svg:not([class*='size-'])]:size-3.5",
    "icon-sm": "size-8 [&_svg:not([class*='size-'])]:size-4",
    "icon-md": "size-9 [&_svg:not([class*='size-'])]:size-4",
    "icon-lg": "size-10 [&_svg:not([class*='size-'])]:size-4.5",
    "icon-xl": "size-11 [&_svg:not([class*='size-'])]:size-5",
} as const;

const spinnerSizes: Record<ButtonSize, string> = {
    xs: "size-3.5",
    sm: "size-4",
    md: "size-4",
    lg: "size-4.5",
    xl: "size-5",
    "icon-xs": "size-3.5",
    "icon-sm": "size-4",
    "icon-md": "size-4",
    "icon-lg": "size-4.5",
    "icon-xl": "size-5",
};

export type ButtonVariant = keyof typeof variants;
export type ButtonSize = keyof typeof sizes;

export interface ButtonProps extends ButtonPrimitive.Props {
    variant?: ButtonVariant;
    size?: ButtonSize;
    /** Shows a spinner and disables the button (it stays focusable). */
    loading?: boolean;
}

export function Button({
    variant = "default",
    size = "sm",
    loading = false,
    disabled,
    focusableWhenDisabled,
    className,
    children,
    ...props
}: ButtonProps) {
    const isIcon = size.startsWith("icon-");
    const spinner = (
        <Spinner label="Loading" className={cn("text-current", spinnerSizes[size])} />
    );

    return (
        <ButtonPrimitive
            disabled={disabled || loading}
            focusableWhenDisabled={focusableWhenDisabled ?? loading}
            aria-busy={loading || undefined}
            className={(state) =>
                cn(
                    "inline-flex shrink-0 cursor-pointer select-none items-center justify-center whitespace-nowrap rounded-md font-medium transition-[color,background-color,border-color,scale] duration-150 ease-out",
                    variant !== "link" && "motion-safe:active:scale-97",
                    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
                    "data-disabled:pointer-events-none data-disabled:not-aria-busy:opacity-50",
                    "[&_svg]:pointer-events-none [&_svg]:shrink-0",
                    variants[variant],
                    sizes[size],
                    typeof className === "function" ? className(state) : className,
                )
            }
            {...props}
        >
            {loading && isIcon ? spinner : (
                <>
                    {loading && spinner}
                    {children}
                </>
            )}
        </ButtonPrimitive>
    );
}
