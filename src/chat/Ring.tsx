import { cn } from "@/lib/cn";

const RADIUS = 6;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/**
 * A 16px progress ring for the chips under the composer: a dim track and an
 * arc in `currentColor` (or `arcClassName`'s colour) for `fraction`.
 */
export function Ring({
    fraction,
    arcClassName
}: {
    fraction: number | null;
    arcClassName?: string;
}) {
    return (
        <svg viewBox="0 0 16 16" className="size-4 shrink-0 -rotate-90" aria-hidden="true">
            <circle
                cx="8"
                cy="8"
                r={RADIUS}
                fill="none"
                strokeWidth="1.8"
                className="stroke-dark-600"
            />
            {fraction != null && fraction > 0 && (
                <circle
                    cx="8"
                    cy="8"
                    r={RADIUS}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeDasharray={CIRCUMFERENCE}
                    strokeDashoffset={CIRCUMFERENCE * (1 - Math.min(fraction, 1))}
                    className={cn(
                        "transition-[stroke-dashoffset] duration-300 ease-out",
                        arcClassName
                    )}
                />
            )}
        </svg>
    );
}
