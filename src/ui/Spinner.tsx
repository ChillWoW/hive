import type { ComponentProps } from "react";
import { cn } from "@/lib/cn";

const sizes = {
    xs: "size-3",
    sm: "size-4",
    md: "size-6",
    lg: "size-8",
    xl: "size-12",
} as const;

export type SpinnerSize = keyof typeof sizes;

export interface SpinnerProps extends ComponentProps<"span"> {
    size?: SpinnerSize;
    label?: string;
}

export function Spinner({ size = "md", label = "Loading", className, ...props }: SpinnerProps) {
    return (
        <span
            role="status"
            aria-label={label}
            className={cn("inline-block shrink-0 text-muted", sizes[size], className)}
            {...props}
        >
            <svg viewBox="0 0 24 24" fill="none" className="size-full animate-spin">
                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2.5" opacity="0.25" />
                <path
                    d="M22 12a10 10 0 0 0-10-10"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                />
            </svg>
        </span>
    );
}
