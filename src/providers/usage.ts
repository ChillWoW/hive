import { useEffect, useRef } from "react";
import { create } from "zustand";
import { isBusy, useChatsStore } from "@/chats";
import { errorMessage } from "@/lib/errors";
import { singleFlight } from "@/lib/singleFlight";
import { onWindowFocus } from "@/lib/windowFocus";
import type { HarnessId, ProviderUsage, UsageWindow } from "@/proto";
import { providersApi } from "./api";

/**
 * Each harness's plan usage (Claude's `/usage` meters), for the ring under
 * the composer. The endpoint is rate-limited, so reads are spaced out: at
 * most once a minute on their own, every 30s when someone opens the card.
 */

export type UsageEntry = {
    /** Undefined until read; null when there's nothing to show. */
    usage?: ProviderUsage | null;
    /** The last read's failure; the last good `usage` stays. */
    error?: string;
    fetchedAt?: number;
    loading: boolean;
};

type UsageState = { entries: Partial<Record<HarnessId, UsageEntry>> };

const useProviderUsageStore = create<UsageState>()(() => ({ entries: {} }));

const EMPTY: UsageEntry = { loading: false };

function patch(harness: HarnessId, next: Partial<UsageEntry>) {
    useProviderUsageStore.setState((s) => ({
        entries: { ...s.entries, [harness]: { ...(s.entries[harness] ?? EMPTY), ...next } }
    }));
}

const MIN_INTERVAL = 60_000;
const FORCED_MIN_INTERVAL = 30_000;
/** While a composer is up: usage moves as turns run. */
const POLL_INTERVAL = 5 * 60_000;

const reads = singleFlight<HarnessId>();
/** When the last read started, failed or not, for the spacing. */
const lastTried = new Map<HarnessId, number>();

export function refreshUsage(
    harness: HarnessId,
    { force = false }: { force?: boolean } = {}
): Promise<void> {
    return reads(harness, async () => {
        const since = Date.now() - (lastTried.get(harness) ?? 0);
        if (since < (force ? FORCED_MIN_INTERVAL : MIN_INTERVAL)) return;
        lastTried.set(harness, Date.now());
        patch(harness, { loading: true });
        try {
            const usage = await providersApi.usage(harness);
            patch(harness, { usage, error: undefined, fetchedAt: Date.now() });
        } catch (error) {
            console.warn("[providers] usage failed", harness, error);
            patch(harness, { error: errorMessage(error) });
        } finally {
            patch(harness, { loading: false });
        }
    });
}

/** A chat on `harness` is mid-turn. */
function useHarnessBusy(harness: HarnessId | undefined) {
    return useChatsStore(
        (s) =>
            !!harness &&
            s.chats.some(
                (c) => c.config.harness === harness && isBusy(s.sessions[c.id]?.status)
            )
    );
}

/**
 * `harness`'s usage, read while mounted: at once, every few minutes, on
 * window focus and when a turn on that harness ends.
 */
export function useProviderUsage(harness: HarnessId | undefined): UsageEntry {
    const entry = useProviderUsageStore((s) => (harness ? s.entries[harness] : undefined)) ?? EMPTY;
    const busy = useHarnessBusy(harness);
    const wasBusy = useRef(busy);

    useEffect(() => {
        const turnEnded = wasBusy.current && !busy;
        wasBusy.current = busy;
        if (harness) void refreshUsage(harness, { force: turnEnded });
    }, [harness, busy]);

    useEffect(() => {
        if (!harness) return;
        const refresh = () => void refreshUsage(harness);
        const timer = window.setInterval(refresh, POLL_INTERVAL);
        const offFocus = onWindowFocus(refresh);
        return () => {
            window.clearInterval(timer);
            offFocus();
        };
    }, [harness]);

    return entry;
}

/** A window's share used, clamped to 0–1. */
const usedOf = (window: UsageWindow) => Math.min(Math.max(window.used, 0), 1);

/** The binding limit: the most-used window. */
export function mostUsed(windows: UsageWindow[]): number | undefined {
    if (windows.length === 0) return undefined;
    return Math.max(...windows.map(usedOf));
}

export type UsageLimitWarning = {
    window: UsageWindow;
    /** Share used, clamped to 0–1. */
    used: number;
    /** `reached` at 100%, else the window's `usageLevel`. */
    level: Exclude<UsageLevel, "normal"> | "reached";
};

/**
 * The window to warn about: the most-used one at 80% or more whose reset
 * hasn't passed (a stale reading of a window that already started over says
 * nothing). Undefined while every window has room.
 */
export function limitWarning(
    windows: UsageWindow[],
    now = Date.now()
): UsageLimitWarning | undefined {
    let worst: UsageLimitWarning | undefined;
    for (const window of windows) {
        const resetsAt = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
        if (Number.isFinite(resetsAt) && resetsAt <= now) continue;
        const used = usedOf(window);
        const level = used >= 1 ? "reached" : usageLevel(used);
        if (level === "normal" || (worst && worst.used >= used)) continue;
        worst = { window, used, level };
    }
    return worst;
}

export type UsageLevel = "normal" | "warn" | "critical";

export function usageLevel(fraction: number): UsageLevel {
    return fraction >= 0.95 ? "critical" : fraction >= 0.8 ? "warn" : "normal";
}

/**
 * "Resets 4:29 PM" within a day, "Resets Tue 11:00 AM" within a week, else
 * "Resets Nov 14".
 */
export function formatReset(resetsAt: string | undefined, now = Date.now()): string | undefined {
    if (!resetsAt) return undefined;
    const at = new Date(resetsAt);
    if (Number.isNaN(at.getTime())) return undefined;
    const hours = (at.getTime() - now) / 3_600_000;
    const time = at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    if (hours < 22) return `Resets ${time}`;
    if (hours < 24 * 7) {
        return `Resets ${at.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
    }
    return `Resets ${at.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}
