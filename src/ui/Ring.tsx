const RADIUS = 6;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/** A 16px progress ring: a dim track and an arc in `currentColor` for `fraction`. */
export function Ring({ fraction }: { fraction: number }) {
    return (
        <svg viewBox="0 0 16 16" className="size-4 shrink-0 -rotate-90" aria-hidden="true">
            <circle
                cx="8"
                cy="8"
                r={RADIUS}
                fill="none"
                strokeWidth="1.8"
                className="stroke-border"
            />
            {fraction > 0 && (
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
                    className="transition-[stroke-dashoffset] duration-300 ease-out"
                />
            )}
        </svg>
    );
}
