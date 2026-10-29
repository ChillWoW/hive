import type { ContextUsage } from "@/proto";
import { cn } from "@/lib/cn";
import { chipClassName } from "@/composer/chip";
import { Tooltip } from "@/ui";

const RADIUS = 6;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

const count = (n: number) => n.toLocaleString("en-US");

/**
 * How full the chat's context window is, as a ring and percent under the
 * composer (as in zeron): muted, warning from 75%, danger from 90%; the
 * token counts in its tooltip. Nothing until the harness reports a window.
 */
export function ContextRing({ usage }: { usage: ContextUsage | undefined }) {
    const capacity = usage?.window;
    if (!capacity) return null;
    const tokens = usage.tokens;
    const fraction = tokens != null ? Math.min(tokens / capacity, 1) : null;
    const tone =
        fraction == null
            ? "text-dark-300"
            : fraction >= 0.9
              ? "text-danger"
              : fraction >= 0.75
                ? "text-warning"
                : "text-dark-200";

    return (
        <Tooltip>
            <Tooltip.Trigger
                render={
                    <span
                        aria-label="Context window"
                        className={cn(
                            chipClassName,
                            "shrink-0 cursor-default gap-1.5 px-1.5 tabular-nums",
                            tone
                        )}
                    >
                        <svg viewBox="0 0 16 16" className="size-4 -rotate-90" aria-hidden="true">
                            <circle
                                cx="8"
                                cy="8"
                                r={RADIUS}
                                fill="none"
                                strokeWidth="1.8"
                                className="stroke-dark-600"
                            />
                            {fraction != null && fraction > 0 && (
                                <circle
                                    cx="8"
                                    cy="8"
                                    r={RADIUS}
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="1.8"
                                    strokeLinecap="round"
                                    strokeDasharray={CIRCUMFERENCE}
                                    strokeDashoffset={CIRCUMFERENCE * (1 - fraction)}
                                    className="transition-[stroke-dashoffset] duration-300 ease-out"
                                />
                            )}
                        </svg>
                        {fraction == null ? "—" : `${Math.round(fraction * 100)}%`}
                    </span>
                }
            />
            <Tooltip.Content side="top">
                <span className="tabular-nums">
                    {tokens != null
                        ? `${count(tokens)} / ${count(capacity)} tokens`
                        : `${count(capacity)} token window`}
                </span>
            </Tooltip.Content>
        </Tooltip>
    );
}
