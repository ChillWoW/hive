/**
 * The rail icon for Outcode's own MCP tools: the app mark's ring and bar
 * (`src-tauri/icons/icon.svg`) without its tile, in `currentColor`, the
 * viewBox cropped to the glyph with a little padding to sit with phosphor.
 */
export function OutcodeIcon({ className }: { className?: string }) {
    return (
        <svg viewBox="70 70 884 884" fill="currentColor" aria-hidden className={className}>
            <circle cx="364" cy="512" r="190" fill="none" stroke="currentColor" strokeWidth="110" />
            <rect x="656" y="647" width="248" height="110" rx="55" />
        </svg>
    );
}
