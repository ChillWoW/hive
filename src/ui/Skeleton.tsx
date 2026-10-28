import { forwardRef } from "react";
import type { HTMLAttributes } from "react";
import { cn } from "@/lib/cn";

type Variant = "text" | "circular" | "rectangular" | "rounded";
type Animation = "pulse" | "shimmer" | "none";

const variantStyles: Record<Variant, string> = {
    text: "rounded-md",
    circular: "rounded-full",
    rectangular: "rounded-none",
    rounded: "rounded-md"
};

const animationStyles: Record<Animation, string> = {
    pulse: "animate-pulse",
    shimmer:
        "relative overflow-hidden before:absolute before:inset-0 before:-translate-x-full before:animate-skeleton-shimmer before:bg-gradient-to-r before:from-transparent before:via-dark-500/40 before:to-transparent",
    none: ""
};

function toDimension(value?: number | string): string | undefined {
    if (value === undefined) return undefined;
    return typeof value === "number" ? `${value}px` : value;
}

export interface SkeletonProps
    extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
    variant?: Variant;
    animation?: Animation;
    width?: number | string;
    height?: number | string;
    /** Number of lines to render. Only applies to the `text` variant. */
    lines?: number;
    /** Width of the final line when rendering multiple text lines. */
    lastLineWidth?: number | string;
    className?: string;
}

export const Skeleton = forwardRef<HTMLDivElement, SkeletonProps>(
    (
        {
            variant = "rectangular",
            animation = "pulse",
            width,
            height,
            lines = 1,
            lastLineWidth = "60%",
            className,
            style,
            ...props
        },
        ref
    ) => {
        const base = cn(
            "block shrink-0 bg-dark-700",
            variantStyles[variant],
            animationStyles[animation]
        );

        if (variant === "text" && lines > 1) {
            return (
                <div
                    ref={ref}
                    className={cn("flex flex-col gap-2", className)}
                    style={style}
                    {...props}
                >
                    {Array.from({ length: lines }).map((_, index) => {
                        const isLast = index === lines - 1;
                        return (
                            <span
                                key={index}
                                className={cn(base, "h-[1em] w-full")}
                                style={{
                                    width: isLast
                                        ? toDimension(lastLineWidth)
                                        : undefined
                                }}
                            />
                        );
                    })}
                </div>
            );
        }

        return (
            <div
                ref={ref}
                className={cn(base, variant === "text" && "h-[1em]", className)}
                style={{
                    width: toDimension(width),
                    height: toDimension(height),
                    ...style
                }}
                {...props}
            />
        );
    }
);

Skeleton.displayName = "Skeleton";
