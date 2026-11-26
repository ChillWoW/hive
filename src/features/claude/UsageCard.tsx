import { ArrowClockwiseIcon, WarningCircleIcon } from "@phosphor-icons/react";
import type { UsageWindow } from "@/proto";
import { ClaudeMark } from "@/features/models/ClaudeMark";
import { cn } from "@/lib/cn";
import { agoLabel, useMinuteClock } from "@/lib/time";
import { IconButton } from "@/ui";
import { useClaudeProvider } from "./store";
import { PLAN_LABELS, refreshUsage, resetsIn, TONE_BG, useClaudeUsage, usageTone } from "./usage";

/** Claude's plan usage at a glance: one bar per window, when each resets, and when it was read. */
export function UsageCard() {
    const windows = useClaudeUsage((s) => s.windows);
    const error = useClaudeUsage((s) => s.error);
    const loading = useClaudeUsage((s) => s.loading);
    const checkedAt = useClaudeUsage((s) => s.checkedAt);
    const plan = useClaudeProvider((s) => s.status?.account?.plan);
    const now = useMinuteClock();

    return (
        <div className="flex flex-col gap-3">
            <div className="flex min-w-0 items-center gap-2">
                <ClaudeMark className="size-4 shrink-0" />
                <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-text">Claude Code</span>
                {plan && (
                    <span className="shrink-0 rounded-full bg-hover px-2 py-px text-[11px] leading-4 text-muted">
                        {PLAN_LABELS[plan] ?? plan}
                    </span>
                )}
                <IconButton label="Refresh" side="top" disabled={loading} onClick={() => void refreshUsage()}>
                    <ArrowClockwiseIcon className={cn("size-3.5", loading && "animate-spin")} />
                </IconButton>
            </div>

            {windows ? (
                <div className="flex flex-col gap-3 border-t border-border pt-3">
                    {windows.map((window) => (
                        <UsageBar key={window.label} window={window} now={now} />
                    ))}
                </div>
            ) : (
                !error && (
                    <p className="text-xs text-muted">
                        {windows === null ? "Shown for a Claude subscription login" : "Checking…"}
                    </p>
                )
            )}

            {error ? (
                <p className="flex items-start gap-1.5 text-[11px] leading-4 text-warning">
                    <WarningCircleIcon className="mt-px size-3 shrink-0" />
                    <span className="min-w-0 break-words">{error}</span>
                </p>
            ) : (
                checkedAt !== undefined &&
                windows && <p className="text-[11px] text-muted/75">Updated {agoLabel(checkedAt, now)}</p>
            )}
        </div>
    );
}

function UsageBar({ window, now }: { window: UsageWindow; now: number }) {
    const percent = Math.round(window.used * 100);
    const reset = resetsIn(window.resetsAt, now);
    return (
        <div className="flex flex-col gap-1.5">
            <div className="flex items-baseline gap-2 text-xs">
                <span className="min-w-0 flex-1 truncate text-text/85">{window.label}</span>
                <span className="text-muted tabular-nums">{percent}%</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-border">
                <div
                    className={cn("h-full rounded-full transition-[width] duration-300", TONE_BG[usageTone(window.used)])}
                    style={{ width: `${Math.min(percent, 100)}%` }}
                />
            </div>
            {reset && <span className="text-[11px] text-muted/75">{reset}</span>}
        </div>
    );
}
