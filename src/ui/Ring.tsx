import { cn } from "@/lib/cn";

/**
 * A progress ring: a dim track and an arc in `currentColor` for `fraction`.
 * 16px by default; size it with `className`. `radius` and `thickness` are in
 * 16ths of its size (the radius must leave room for half the stroke: ≤ 8 − thickness / 2).
 */
export function Ring({
    fraction,
    radius = 6,
    thickness = 1.8,
    className
}: {
    fraction: number;
    radius?: number;
    thickness?: number;
    className?: string;
}) {
    const circumference = 2 * Math.PI * radius;
    return (
        <svg viewBox="0 0 16 16" className={cn("size-4 shrink-0 -rotate-90", className)} aria-hidden="true">
            <circle cx="8" cy="8" r={radius} fill="none" strokeWidth={thickness} className="stroke-border" />
            {fraction > 0 && (
                <circle
                    cx="8"
                    cy="8"
                    r={radius}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={thickness}
                    strokeLinecap="round"
                    strokeDasharray={circumference}
                    strokeDashoffset={circumference * (1 - Math.min(fraction, 1))}
                    className="transition-[stroke-dashoffset] duration-300 ease-out"
                />
            )}
        </svg>
    );
}
