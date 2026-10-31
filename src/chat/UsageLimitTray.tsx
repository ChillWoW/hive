import { ChartBarIcon, GaugeIcon, XIcon } from "@phosphor-icons/react";
import { create } from "zustand";
import { cn } from "@/lib/cn";
import { trayClassName } from "./tray";
import type { HarnessId } from "@/proto";
import {
    formatReset,
    limitWarning,
    useProviderUsage,
    type UsageLimitWarning
} from "@/providers";
import { useUsageStore } from "@/usage/store";

const TITLE: Record<UsageLimitWarning["level"], string> = {
    warn: "Nearing your usage limit",
    critical: "Almost out of usage",
    reached: "Usage limit reached"
};

const TONE: Record<UsageLimitWarning["level"], string> = {
    warn: "text-warning",
    critical: "text-danger",
    reached: "text-danger"
};

/** Warnings dismissed this session, by `warningKey`. */
const useDismissed = create<{ keys: string[] }>()(() => ({ keys: [] }));

/**
 * A dismissal holds for this window at this level until it resets: getting
 * worse (critical, reached) or a new window period brings it back.
 */
function warningKey(harness: HarnessId, warning: UsageLimitWarning): string {
    return [harness, warning.window.label, warning.level, warning.window.resetsAt ?? ""].join("|");
}

const buttonClassName = cn(
    "inline-flex h-5 shrink-0 items-center gap-1 rounded-md px-1.5 text-dark-200 outline-none",
    "transition-colors hover:bg-dark-700 hover:text-dark-50 focus-visible:bg-dark-700"
);

/**
 * One line above the composer while the harness's plan usage is at 80% or
 * more of a window (as t3code's composer banners do): which window, how much
 * is used, when it resets. Limits opens Usage › Limits; ✕ hides it until the
 * window gets worse or starts over.
 */
export function UsageLimitTray({ harness }: { harness: HarnessId }) {
    const { usage } = useProviderUsage(harness);
    const dismissed = useDismissed((s) => s.keys);
    const warning = usage ? limitWarning(usage.windows) : undefined;
    if (!warning) return null;
    const key = warningKey(harness, warning);
    if (dismissed.includes(key)) return null;

    const tone = TONE[warning.level];
    const reset = formatReset(warning.window.resetsAt);
    const percent = Math.round(warning.used * 100);

    return (
        <div role="status" className={cn(trayClassName, "pt-0.5 pb-0.5")}>
            <div className="flex h-6 min-w-0 items-center gap-1.5 px-2.5 text-xs">
                <GaugeIcon className={cn("size-3.5 shrink-0", tone)} weight="bold" />
                <span className="shrink-0 font-medium text-dark-100">{TITLE[warning.level]}</span>
                <span className="min-w-0 truncate text-dark-250 tabular-nums">
                    · {warning.window.label}
                    {warning.level !== "reached" && (
                        <span className={tone}> {percent}%</span>
                    )}
                    {reset && ` · ${reset}`}
                </span>
                <span className="ml-auto flex shrink-0 items-center gap-0.5 -mr-1.5">
                    <button
                        type="button"
                        onClick={() => {
                            const usageStore = useUsageStore.getState();
                            usageStore.setMetric("limits");
                            usageStore.setOpen(true);
                        }}
                        className={buttonClassName}
                    >
                        <ChartBarIcon className="size-3" />
                        Limits
                    </button>
                    <button
                        type="button"
                        aria-label="Dismiss usage warning"
                        onClick={() => useDismissed.setState((s) => ({ keys: [...s.keys, key] }))}
                        className={cn(buttonClassName, "px-1")}
                    >
                        <XIcon className="size-3" />
                    </button>
                </span>
            </div>
        </div>
    );
}
