import { useEffect, useState } from "react";
import { ArrowClockwiseIcon } from "@phosphor-icons/react";
import { chipTriggerClassName, popupClassName } from "@/composer/chip";
import { HarnessIcon, useCatalog } from "@/harnesses";
import { cn } from "@/lib/cn";
import type { HarnessId, UsageWindow } from "@/proto";
import {
    formatReset,
    mostUsed,
    refreshProvider,
    refreshUsage,
    useProvider,
    useProviderUsage,
    usageLevel,
    type UsageEntry,
    type UsageLevel
} from "@/providers";
import { Popover, usePortalContainer } from "@/ui";
import { Ring } from "./Ring";

const ARC: Record<UsageLevel, string> = {
    normal: "text-info",
    warn: "text-warning",
    critical: "text-danger"
};
const LABEL: Record<UsageLevel, string> = {
    normal: "text-dark-200",
    warn: "text-warning",
    critical: "text-danger"
};
const FILL: Record<UsageLevel, string> = {
    normal: "bg-info/80",
    warn: "bg-warning/90",
    critical: "bg-danger/90"
};

const percent = (fraction: number) => `${Math.round(fraction * 100)}%`;
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * How much of the plan's rate limits the harness's account has used, as in
 * zeron: a ring of the most-used window beside the context ring (blue, so
 * the two read apart; warning from 80%, danger from 95%). Click opens the
 * account with a meter per window. Hidden when the harness reports none;
 * a check that failed before any reading shows as "—", its card saying why.
 */
export function UsageRing({ harness }: { harness: HarnessId }) {
    const entry = useProviderUsage(harness);
    const { usage } = entry;
    const container = usePortalContainer();
    const [open, setOpen] = useState(false);
    const fraction = usage ? mostUsed(usage.windows) : undefined;
    const failed = usage === undefined && !!entry.error;
    if (fraction == null && !failed) return null;
    const level = fraction == null ? "normal" : usageLevel(fraction);

    return (
        <Popover
            open={open}
            onOpenChange={(next) => {
                setOpen(next);
                // Opening the card is when someone cares: read again.
                if (next) void refreshUsage(harness, { force: true });
            }}
        >
            <Popover.Trigger
                aria-label="Plan usage"
                className={cn(
                    chipTriggerClassName,
                    "shrink-0 gap-1.5 px-1.5 tabular-nums",
                    fraction == null ? "text-dark-300" : LABEL[level]
                )}
            >
                <Ring fraction={fraction ?? null} arcClassName={ARC[level]} />
                {fraction == null ? "—" : percent(fraction)}
            </Popover.Trigger>
            <Popover.Portal container={container ?? undefined}>
                <Popover.Positioner
                    side="top"
                    align="end"
                    sideOffset={10}
                    collisionPadding={{ top: 48, right: 12, bottom: 12, left: 12 }}
                >
                    <Popover.Popup
                        aria-label="Plan usage"
                        className={cn(popupClassName, "w-80 min-w-0 rounded-xl p-0")}
                    >
                        <UsageCard harness={harness} entry={entry} />
                    </Popover.Popup>
                </Popover.Positioner>
            </Popover.Portal>
        </Popover>
    );
}

function UsageCard({ harness, entry }: { harness: HarnessId; entry: UsageEntry }) {
    const catalog = useCatalog(harness);
    const { usage, error, loading, fetchedAt } = entry;
    const provider = useProvider(harness);
    const account = provider.status?.account;

    const known = !!provider.status;
    // The email and plan come from the CLI's login check (shared, deduped).
    useEffect(() => {
        if (!known) void refreshProvider(harness);
    }, [harness, known]);

    return (
        <div className="flex flex-col">
            <div className="flex items-center gap-2.5 px-3 pt-3 pb-2.5">
                <HarnessIcon harness={harness} className="size-4 shrink-0" />
                <div className="min-w-0 flex-1">
                    <div className="truncate text-[12.5px] font-medium text-dark-50">
                        {catalog?.label ?? "Account"}
                    </div>
                    <div className="truncate text-[11px] text-dark-300">
                        {account?.email ?? (provider.probing ? "Loading…" : "Signed in")}
                    </div>
                </div>
                {account?.plan && (
                    <span className="shrink-0 rounded-sm bg-dark-700 px-1.5 py-0.5 text-[10.5px] font-medium text-dark-100">
                        {capitalize(account.plan)}
                    </span>
                )}
            </div>
            {!!usage?.windows.length && (
                <div className="flex flex-col gap-3 border-t border-dark-700 px-3 py-3">
                    {usage.windows.map((window) => (
                        <Meter key={window.label} window={window} />
                    ))}
                </div>
            )}
            <div className="flex items-center gap-2 border-t border-dark-700 py-1.5 pr-1.5 pl-3 text-[11px]">
                <span
                    className={cn("min-w-0 flex-1 line-clamp-2", error ? "text-danger" : "text-dark-300")}
                >
                    {error ?? (fetchedAt ? `Updated ${ago(fetchedAt)}` : "")}
                </span>
                <button
                    type="button"
                    aria-label="Refresh usage"
                    disabled={loading}
                    onClick={() => void refreshUsage(harness, { force: true })}
                    className="grid size-6 place-items-center rounded-md text-dark-300 outline-none transition-colors hover:bg-dark-700 hover:text-dark-50 disabled:pointer-events-none"
                >
                    <ArrowClockwiseIcon className={cn("size-3.5", loading && "animate-spin")} />
                </button>
            </div>
        </div>
    );
}

/** One window: label and percent, a bar, when it resets. */
function Meter({ window }: { window: UsageWindow }) {
    const fraction = Math.min(Math.max(window.used, 0), 1);
    const level = usageLevel(fraction);
    const reset = formatReset(window.resetsAt);
    return (
        <div className="flex flex-col gap-1.5">
            <div className="flex items-baseline gap-2 text-xs">
                <span className="min-w-0 flex-1 truncate text-dark-100">{window.label}</span>
                <span className={cn("shrink-0 tabular-nums", LABEL[level])}>
                    {percent(fraction)} used
                </span>
            </div>
            <div className="h-1 overflow-hidden rounded-full bg-dark-700">
                {fraction > 0 && (
                    <div
                        // A floor keeps tiny non-zero usage visible.
                        style={{ width: `${Math.max(fraction, 0.015) * 100}%` }}
                        className={cn(
                            "h-full rounded-full transition-[width] duration-300 ease-out",
                            FILL[level]
                        )}
                    />
                )}
            </div>
            {reset && <span className="text-[11px] text-dark-300">{reset}</span>}
        </div>
    );
}

function ago(at: number): string {
    const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
    if (seconds < 45) return "just now";
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    return `${Math.round(minutes / 60)}h ago`;
}
