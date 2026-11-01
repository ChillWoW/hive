/** `3.50B`, `55.4M`, `352K`, `980`. */
export function formatTokens(value: number): string {
    const abs = Math.abs(value);
    if (abs >= 1e9) return `${three(value / 1e9)}B`;
    if (abs >= 1e6) return `${three(value / 1e6)}M`;
    if (abs >= 1e3) return `${three(value / 1e3)}K`;
    return String(Math.round(value));
}

/** `1,234,567`. */
export const formatCount = (value: number) => value.toLocaleString("en-US");

/** "just now", "5m ago", "3h ago", "2d ago". */
export function formatAgo(at: number, now = Date.now()): string {
    const seconds = Math.max(0, Math.round((now - at) / 1000));
    if (seconds < 45) return "just now";
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 48) return `${hours}h ago`;
    return `${Math.round(hours / 24)}d ago`;
}

/** Three significant digits: 3.50, 55.4, 352. */
function three(n: number): string {
    const abs = Math.abs(n);
    return abs >= 100 ? n.toFixed(0) : abs >= 10 ? n.toFixed(1) : n.toFixed(2);
}
