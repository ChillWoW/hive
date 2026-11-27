import { ArrowsInLineVerticalIcon, StackIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/cn";
import { formatTokens } from "@/lib/format";
import { timeAgo } from "@/lib/time";
import { Tooltip } from "@/ui";

/**
 * A line above the composer, back in a big Claude chat after its prompt
 * cache expired: the next prompt would re-read the whole conversation at
 * full price, so it compacts first. The button keeps the full history for
 * that prompt instead (amber: that's the costly way), or goes back.
 */
export function IdleCompactNotice({
    tokens,
    idleSince,
    now,
    compactFirst,
    onChange
}: {
    tokens: number;
    /** Epoch millis of the chat's last message. */
    idleSince: number;
    now: number;
    /** The next prompt compacts first; false keeps the full history. */
    compactFirst: boolean;
    onChange: (compactFirst: boolean) => void;
}) {
    const Icon = compactFirst ? ArrowsInLineVerticalIcon : StackIcon;
    const size = formatTokens(tokens);
    return (
        <div
            role="status"
            className={cn(
                "@container mb-2 flex min-h-8 items-center gap-2 rounded-xl border py-1 pr-1 pl-2.5 text-[13px]",
                "transition-[opacity,translate,background-color,border-color] duration-200 ease-out",
                "starting:translate-y-1 starting:opacity-0",
                compactFirst ? "border-border bg-surface" : "border-warning/25 bg-warning/8"
            )}
        >
            <Icon className={cn("size-4 shrink-0", compactFirst ? "text-muted" : "text-warning")} />
            <Tooltip>
                <Tooltip.Trigger
                    render={
                        <span className="flex min-w-0 flex-1 items-baseline gap-2">
                            <span className="truncate text-text">
                                {compactFirst ? "Next prompt compacts first" : `Next prompt re-reads all ${size}`}
                            </span>
                            {/* Room permitting: what's at stake. */}
                            <span className="hidden shrink-0 text-xs text-muted tabular-nums @md:inline">
                                {compactFirst ? `${size} tokens` : "uncached"} · idle {timeAgo(idleSince, now)}
                            </span>
                        </span>
                    }
                />
                <Tooltip.Content side="top" className="max-w-72">
                    Cache expired: history costs full price
                </Tooltip.Content>
            </Tooltip>
            <button
                type="button"
                onClick={() => onChange(!compactFirst)}
                className={cn(
                    "h-6 shrink-0 rounded-md px-2 text-xs outline-none select-none transition-colors duration-150",
                    compactFirst
                        ? "text-muted hover:bg-hover hover:text-text focus-visible:bg-hover focus-visible:text-text"
                        : "text-warning hover:bg-warning/12 focus-visible:bg-warning/12"
                )}
            >
                {compactFirst ? "Keep full history" : "Compact first"}
            </button>
        </div>
    );
}
