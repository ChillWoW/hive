import { formatTokens } from "@/lib/format";
import type { Measure } from "./store";

export { formatAgo, formatCount, formatTokens } from "@/lib/format";

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

/** A value of `measure`: dollars or processed tokens. */
export const formatMeasure = (value: number, measure: Measure, { exact = false } = {}) =>
    measure === "cost" ? formatUsd(value, { exact }) : formatTokens(value);

export function formatPercent(fraction: number): string {
    if (!Number.isFinite(fraction) || fraction <= 0) return "0%";
    if (fraction < 0.01) return "<1%";
    return `${Math.round(fraction * 100)}%`;
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
const formatWeekday = (ms: number) => weekdayFormat.format(ms);
export const formatHour = (ms: number) => hourFormat.format(ms);

/** A chart bucket by its start: its day, or with `hourly` its day and hour. */
export const formatBucket = (start: number, hourly: boolean) =>
    hourly ? `${formatWeekday(start)}, ${formatHour(start)}` : formatWeekday(start);

/** The last two segments of a folder path, for tables. */
export function shortPath(path: string): string {
    const parts = path.split(/[\\/]/).filter(Boolean);
    return parts.length <= 2 ? path : `…/${parts.slice(-2).join("/")}`;
}
