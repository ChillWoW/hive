import { useSyncExternalStore } from "react";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

/** "now", "5m", "3h", "2d", "3w", "4mo", "1y". */
export function timeAgo(at: number, now: number): string {
    const ago = Math.max(0, now - at);
    if (ago < MINUTE) return "now";
    if (ago < HOUR) return `${Math.floor(ago / MINUTE)}m`;
    if (ago < DAY) return `${Math.floor(ago / HOUR)}h`;
    if (ago < WEEK) return `${Math.floor(ago / DAY)}d`;
    if (ago < MONTH) return `${Math.floor(ago / WEEK)}w`;
    if (ago < YEAR) return `${Math.floor(ago / MONTH)}mo`;
    return `${Math.floor(ago / YEAR)}y`;
}

/** One clock for every row, ticking each minute while something reads it. */
let now = Date.now();
const listeners = new Set<() => void>();
let timer: number | undefined;

function subscribe(listener: () => void) {
    listeners.add(listener);
    if (timer === undefined) {
        now = Date.now();
        timer = window.setInterval(() => {
            now = Date.now();
            for (const l of listeners) l();
        }, MINUTE / 2);
    }
    return () => {
        listeners.delete(listener);
        if (!listeners.size) {
            window.clearInterval(timer);
            timer = undefined;
        }
    };
}

export function useMinuteClock(): number {
    return useSyncExternalStore(subscribe, () => now);
}
