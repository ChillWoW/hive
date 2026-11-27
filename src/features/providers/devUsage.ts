import type { UsageWindow } from "@/proto";

/**
 * Dev builds can pose as a plan near its limit, to see the warnings:
 * `?usage=93` in the URL puts every provider's first window at 93%.
 */
export function devUsage(windows: UsageWindow[]): UsageWindow[] {
    if (!import.meta.env.DEV || typeof window === "undefined") return windows;
    const percent = Number.parseFloat(new URLSearchParams(window.location.search).get("usage") ?? "");
    if (!Number.isFinite(percent)) return windows;
    return windows.map((w, i) => (i === 0 ? { ...w, used: Math.min(Math.max(percent / 100, 0), 1) } : w));
}
