import { ArrowsInLineVerticalIcon, StackIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/cn";
import { formatTokens } from "@/lib/format";
import { chipTriggerClassName } from "@/ui/chip";
import { Tooltip } from "@/ui";

/**
 * Back in a big Claude chat after its prompt cache expired (after t3code's
 * Compact chip): on, the next prompt compacts the conversation first, so it
 * isn't re-read in full; click to keep the full history for that prompt.
 */
export function StaleCompactChip({
    tokens,
    on,
    onChange
}: {
    tokens: number;
    on: boolean;
    onChange: (on: boolean) => void;
}) {
    const Icon = on ? ArrowsInLineVerticalIcon : StackIcon;
    return (
        <Tooltip>
            <Tooltip.Trigger
                render={
                    <button
                        type="button"
                        aria-pressed={on}
                        onClick={() => onChange(!on)}
                        className={cn(chipTriggerClassName, "shrink-0", on && "text-info")}
                    >
                        <Icon className="size-3.5" />
                        {on ? "Compact" : "Full"}
                        <span className="text-dark-250 tabular-nums">{formatTokens(tokens)}</span>
                    </button>
                }
            />
            <Tooltip.Content side="top" className="max-w-64">
                {on
                    ? "The prompt cache has expired. Your next prompt summarizes the conversation first, so its history isn't re-read in full. Click to keep the full history."
                    : "Your next prompt keeps the full history and re-reads it uncached. Click to compact first."}
            </Tooltip.Content>
        </Tooltip>
    );
}
