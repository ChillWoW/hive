import { useEffect, useState } from "react";
import { cn } from "@/lib/cn";

const DOTS = 9;
const ALL_LIT = (1 << DOTS) - 1;

/** A random pattern of lit dots, never empty or full, and never `previous`. */
function nextPattern(previous: number): number {
    let pattern: number;
    do {
        pattern = Math.floor(Math.random() * ALL_LIT);
    } while (pattern === 0 || pattern === previous);
    return pattern;
}

function prefersReducedMotion(): boolean {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export type DotMatrixSpinnerProps = {
    /** Milliseconds between patterns. */
    interval?: number;
    /** What a screen reader announces. */
    label?: string;
    /**
     * Holds these dots lit (bit `i` is dot `i`, row by row) instead of
     * cycling, for a state that is waiting rather than working.
     */
    pattern?: number;
    /** Sizes the grid (`size-3` by default); dots take `currentColor`. */
    className?: string;
};

/** Every dot lit, for `pattern`. */
export const DOT_MATRIX_FULL = ALL_LIT;

/**
 * A 3×3 grid of dots lighting in a new random pattern every `interval`:
 * something is happening, with no idea how long it will take. Holds still
 * under reduced motion. (Ported from Desktop/agent.)
 */
export function DotMatrixSpinner({
    interval = 260,
    label = "Loading",
    pattern: held,
    className
}: DotMatrixSpinnerProps) {
    const [cycling, setCycling] = useState(() => nextPattern(0));
    const pattern = held ?? cycling;

    useEffect(() => {
        if (held !== undefined || prefersReducedMotion()) return;
        const timer = setInterval(() => setCycling(nextPattern), interval);
        return () => clearInterval(timer);
    }, [interval, held]);

    return (
        <span
            role="status"
            aria-label={label}
            className={cn("grid size-3 shrink-0 grid-cols-3 gap-px", className)}
        >
            {Array.from({ length: DOTS }, (_, i) => (
                <span
                    key={i}
                    className={cn(
                        "rounded-full bg-current transition-opacity duration-200",
                        pattern & (1 << i) ? "opacity-100" : "opacity-20"
                    )}
                />
            ))}
        </span>
    );
}
