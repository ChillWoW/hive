import type { ContextWindow } from "@/proto";
import { cn } from "@/lib/cn";
import { Ring, Tooltip } from "@/ui";

/** `84,000` as `84k`. */
function formatTokens(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1000) return `${Math.round(n / 1000)}k`;
    return String(n);
}

/**
 * How full the chat's context window is, as a ring under the composer:
 * amber past 70%, red past 90%. The tooltip has the numbers and says
 * `/compact` frees it up.
 */
export function ContextMeter({ context }: { context: ContextWindow | undefined }) {
    if (context?.tokens === undefined || !context.window) return null;
    const fraction = Math.min(context.tokens / context.window, 1);
    const percent = Math.round(fraction * 100);
    return (
        <Tooltip>
            <Tooltip.Trigger
                render={
                    <span
                        role="img"
                        aria-label={`Context ${percent}% full`}
                        className={cn(
                            "inline-flex size-6 shrink-0 items-center justify-center rounded-full",
                            fraction > 0.9 ? "text-danger" : fraction > 0.7 ? "text-warning" : "text-muted"
                        )}
                    >
                        <Ring fraction={fraction} />
                    </span>
                }
            />
            <Tooltip.Content side="top" align="end">
                <span className="flex flex-col">
                    <span>
                        Context {percent}% full · {formatTokens(context.tokens)} of {formatTokens(context.window)} tokens
                    </span>
                    {fraction > 0.5 && <span className="text-muted">/compact frees it up</span>}
                </span>
            </Tooltip.Content>
        </Tooltip>
    );
}
