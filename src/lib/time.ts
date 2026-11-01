import { useEffect, useState, useSyncExternalStore } from "react";

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

/** "21h ago"; "just now" under a minute. */
export function agoLabel(at: number, now: number): string {
    const ago = timeAgo(at, now);
    return ago === "now" ? "just now" : `${ago} ago`;
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


/** Now, re-read every `ms` while `live`; read afresh on each render otherwise. */
export function useNow(live: boolean, ms = 1000): number {
    const [now, setNow] = useState(Date.now);
    useEffect(() => {
        if (!live) return;
        setNow(Date.now());
        const id = setInterval(() => setNow(Date.now()), ms);
        return () => clearInterval(id);
    }, [live, ms]);
    return live ? now : Date.now();
}

/**
 * How long something ran: `12s`, `1m 5s`, `2h 3m`. `pad` zero-pads the
 * smaller unit (`1m 05s`); `round` rounds to the second rather than flooring.
 */
export function formatElapsed(ms: number, { pad = false, round = false } = {}): string {
    const s = Math.max(0, round ? Math.round(ms / 1000) : Math.floor(ms / 1000));
    const two = (n: number) => (pad ? String(n).padStart(2, "0") : String(n));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    return m < 60 ? `${m}m ${two(s % 60)}s` : `${Math.floor(m / 60)}h ${two(m % 60)}m`;
}
