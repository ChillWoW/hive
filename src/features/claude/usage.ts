import { useEffect } from "react";
import { create } from "zustand";
import type { UsageWindow } from "@/proto";
import { onWindowFocus } from "@/lib/windowFocus";
import { claudeApi } from "./api";

type UsageState = {
    /** The plan's windows; null without a subscription login; undefined until first read. */
    windows?: UsageWindow[] | null;
    /** What went wrong on the last read; earlier windows are kept. */
    error?: string;
    loading: boolean;
    /** When the last read finished (ms). */
    checkedAt?: number;
};

/** Claude's plan usage, shared by Settings › Providers and the dock. */
export const useClaudeUsage = create<UsageState>()(() => ({ loading: false }));

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Reads are cheap but the endpoint answers 429 when asked too often. */
const POLL_MS = 5 * 60_000;
/** How old a read may be before a glance (focus, hover) reads it again. */
export const USAGE_FRESH_MS = 60_000;

let inflight: Promise<void> | undefined;

/** Reads the usage again, unless a read is running or one finished under `maxAge` ms ago. */
export function refreshUsage({ maxAge = 0 }: { maxAge?: number } = {}): Promise<void> {
    if (inflight) return inflight;
    const { checkedAt } = useClaudeUsage.getState();
    if (maxAge && checkedAt && Date.now() - checkedAt < maxAge) return Promise.resolve();
    useClaudeUsage.setState({ loading: true });
    inflight = claudeApi
        .usage()
        .then(
            (windows) => useClaudeUsage.setState({ windows, error: undefined }),
            (error: unknown) => useClaudeUsage.setState({ error: message(error) })
        )
        .finally(() => {
            useClaudeUsage.setState({ loading: false, checkedAt: Date.now() });
            inflight = undefined;
        });
    return inflight;
}

/** Keeps the usage fresh while `enabled`: now, every few minutes, and on window focus. */
export function useUsagePolling(enabled: boolean) {
    useEffect(() => {
        if (!enabled) return;
        void refreshUsage({ maxAge: USAGE_FRESH_MS });
        const timer = window.setInterval(() => void refreshUsage(), POLL_MS);
        const off = onWindowFocus(() => void refreshUsage({ maxAge: USAGE_FRESH_MS }));
        return () => {
            window.clearInterval(timer);
            off();
        };
    }, [enabled]);
}

/** The most-used window, which is the one closest to blocking. */
export function tightestWindow(windows: UsageWindow[] | null | undefined): UsageWindow | undefined {
    return windows?.reduce<UsageWindow | undefined>((top, w) => (!top || w.used > top.used ? w : top), undefined);
}

/** Bar and ring colour: accent, amber past 70%, red past 90%. */
export function usageTone(used: number): "danger" | "warning" | "accent" {
    return used > 0.9 ? "danger" : used > 0.7 ? "warning" : "accent";
}

/** "Resets in 2h 5m", "Resets in 3d". */
export function resetsIn(iso: string | undefined, now = Date.now()): string | undefined {
    if (!iso) return undefined;
    const ms = Date.parse(iso) - now;
    if (!Number.isFinite(ms)) return undefined;
    if (ms <= 0) return "Resets now";
    const minutes = Math.round(ms / 60_000);
    if (minutes < 60) return `Resets in ${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `Resets in ${hours}h ${minutes % 60}m`;
    return `Resets in ${Math.round(hours / 24)}d`;
}

export const PLAN_LABELS: Record<string, string> = { pro: "Pro", max: "Max", team: "Team", enterprise: "Enterprise" };

export const TONE_BG = { danger: "bg-danger", warning: "bg-warning", accent: "bg-accent" } as const;
export const TONE_TEXT = { danger: "text-danger", warning: "text-warning", accent: "text-accent" } as const;
