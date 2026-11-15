/**
 * The rail icon for a thought: lucide's `brain`
 * (lucide-static, ISC), inlined, in `currentColor`. Shrunk to 88% inside a
 * padded viewBox and stroked so it draws phosphor regular's ~1px line at
 * 16px, matching the phosphor icons' size and weight beside it.
 */
export function ThoughtIcon({ className }: { className?: string }) {
    return (
        <svg
            viewBox="-1.64 -1.64 27.28 27.28"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
            className={className}
        >
            <path d="M12 18V5" />
            <path d="M15 13a4.17 4.17 0 01-3-4 4.17 4.17 0 01-3 4" />
            <path d="M17.707 6.294A3 3 0 1012 5a3 3 0 10-5.707 1.294" />
            <path d="M17.996 5.125a4 4 0 012.526 5.77" />
            <path d="M18 18a4 4 0 002-7.465" />
            <path d="M19.967 17.482a4 4 0 11-7.967.517 4 4 0 11-7.967-.517" />
            <path d="M6 18a4 4 0 01-2-7.465" />
            <path d="M6.004 5.125a4 4 0 00-2.526 5.77" />
        </svg>
    );
}
