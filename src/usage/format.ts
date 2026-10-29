const usd0 = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0
});
const usd2 = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
});

/** `$1,395`, `$12.56`, `<$0.01`, `$0`. */
export function formatUsd(value: number, { exact = false } = {}): string {
    if (value === 0) return "$0";
    if (value > 0 && value < 0.01) return "<$0.01";
    return !exact && value >= 1000 ? usd0.format(value) : usd2.format(value);
}

/** Short tick labels: `$1.2k`, `$40`, `$0.50`. */
export function formatUsdTick(value: number): string {
    if (value >= 1000) return `$${trim(value / 1000)}k`;
    if (Number.isInteger(value)) return `$${value}`;
    return `$${value.toFixed(2)}`;
}

/** Short tick labels: `60M`, `2.5B`, `500K`. */
export function formatTokensTick(value: number): string {
    return formatTokens(value).replace(/\.0+(?=[KMB]?$)/, "");
}

/** `3.50B`, `55.4M`, `352K`, `980`. */
export function formatTokens(value: number): string {
    const abs = Math.abs(value);
    if (abs >= 1e9) return `${three(value / 1e9)}B`;
    if (abs >= 1e6) return `${three(value / 1e6)}M`;
    if (abs >= 1e3) return `${three(value / 1e3)}K`;
    return String(Math.round(value));
}

export const formatCount = (value: number) => value.toLocaleString("en-US");

export function formatPercent(fraction: number): string {
    if (!Number.isFinite(fraction) || fraction <= 0) return "0%";
    if (fraction < 0.01) return "<1%";
    return `${Math.round(fraction * 100)}%`;
}

/** Three significant digits: 3.50, 55.4, 352. */
function three(n: number): string {
    const abs = Math.abs(n);
    return abs >= 100 ? n.toFixed(0) : abs >= 10 ? n.toFixed(1) : n.toFixed(2);
}

function trim(n: number): string {
    return n.toFixed(1).replace(/\.0$/, "");
}

const dayFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const weekdayFormat = new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric"
});
const hourFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric" });

export const formatDay = (ms: number) => dayFormat.format(ms);
export const formatWeekday = (ms: number) => weekdayFormat.format(ms);
export const formatHour = (ms: number) => hourFormat.format(ms);

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

/** The last two segments of a folder path, for tables. */
export function shortPath(path: string): string {
    const parts = path.split(/[\\/]/).filter(Boolean);
    return parts.length <= 2 ? path : `…/${parts.slice(-2).join("/")}`;
}
