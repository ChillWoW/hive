import type { UsageWindow } from "@/proto";
import { claude } from "./store";

export { USAGE_FRESH_MS } from "@/features/providers/makeProvider";

/** Claude's plan usage, shared by Settings › Providers and the dock. */
export const useClaudeUsage = claude.useUsage;
export const refreshUsage = claude.refreshUsage;
export const useUsagePolling = claude.useUsagePolling;

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

/** Plan names as the CLIs report them (Claude's and ChatGPT's). */
export const PLAN_LABELS: Record<string, string> = {
    free: "Free",
    plus: "Plus",
    pro: "Pro",
    max: "Max",
    team: "Team",
    business: "Business",
    edu: "Edu",
    enterprise: "Enterprise"
};

export const TONE_BG = { danger: "bg-danger", warning: "bg-warning", accent: "bg-accent" } as const;
export const TONE_TEXT = { danger: "text-danger", warning: "text-warning", accent: "text-accent" } as const;
