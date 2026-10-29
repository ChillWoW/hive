/**
 * Hive's mark without its tile: the logo's hexagon ring and centre dot
 * (`src-tauri/icons/icon.svg`), in `currentColor`. Drawn on phosphor's 16px
 * grid with a lighter ring, so it sits among phosphor icons.
 */
export function HiveMark({ className }: { className?: string }) {
    return (
        <svg viewBox="0 0 16 16" fill="none" aria-hidden className={className}>
            <path
                d="M8 1.75L13.41 4.88V11.13L8 14.25L2.59 11.13V4.88Z"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinejoin="round"
            />
            <path
                d="M8 5.85L9.86 6.93V9.07L8 10.15L6.14 9.07V6.93Z"
                fill="currentColor"
                stroke="currentColor"
                strokeWidth="0.5"
                strokeLinejoin="round"
            />
        </svg>
    );
}
