import type { ComponentProps } from "react";
import { cn } from "@/lib/cn";

const animations = {
    // The gradient is sized and fixed to the viewport, so every skeleton on screen
    // shares one highlight that sweeps across them all in sync.
    shimmer: cn(
        "bg-linear-90 from-transparent from-35% via-white/10 via-50% to-transparent to-65%",
        "bg-fixed bg-size-[200vw_100%] bg-no-repeat animate-skeleton-shimmer",
        "motion-reduce:animate-none motion-reduce:bg-none",
    ),
    pulse: "animate-skeleton-pulse motion-reduce:animate-none",
    none: "",
} as const;

export type SkeletonAnimation = keyof typeof animations;

export interface SkeletonProps extends ComponentProps<"div"> {
    /** `shimmer` (default) sweeps a highlight across, `pulse` fades in and out. */
    animation?: SkeletonAnimation;
}

/**
 * Placeholder block shown while content loads. Size and shape it with classes
 * (e.g. `h-4 w-32`, `size-10 rounded-full`). Hidden from assistive tech; mark the
 * loading region with `aria-busy` instead.
 */
export function Skeleton({ animation = "shimmer", className, ...props }: SkeletonProps) {
    return (
        <div
            data-slot="skeleton"
            aria-hidden
            className={cn("shrink-0 rounded-md bg-raised", animations[animation], className)}
            {...props}
        />
    );
}

export interface SkeletonTextProps extends ComponentProps<"div"> {
    /** Number of lines. Default `3`. The last line is shorter. */
    lines?: number;
    animation?: SkeletonAnimation;
}

/** A paragraph of placeholder lines. */
function SkeletonText({ lines = 3, animation, className, ...props }: SkeletonTextProps) {
    return (
        <div data-slot="skeleton-text" aria-hidden className={cn("flex w-full flex-col gap-2", className)} {...props}>
            {Array.from({ length: lines }, (_, i) => (
                <Skeleton
                    key={i}
                    animation={animation}
                    className={cn("h-3 rounded-sm", i === lines - 1 && lines > 1 ? "w-3/5" : "w-full")}
                />
            ))}
        </div>
    );
}

Skeleton.Text = SkeletonText;
