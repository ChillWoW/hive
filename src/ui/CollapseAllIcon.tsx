/**
 * "Collapse all" in Phosphor's style (256 grid, 16 stroke): a square with a
 * minus, a second one stacked behind it, as in an editor's file tree.
 */
export function CollapseAllIcon({ className }: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 256 256"
            fill="none"
            stroke="currentColor"
            strokeWidth={16}
            strokeLinecap="round"
            strokeLinejoin="round"
            className={className}
            aria-hidden
        >
            <rect x="40" y="72" width="144" height="144" rx="16" />
            <path d="M72,72V56a16,16,0,0,1,16-16H200a16,16,0,0,1,16,16V168a16,16,0,0,1-16,16H184" />
            <path d="M80,144h64" />
        </svg>
    );
}
