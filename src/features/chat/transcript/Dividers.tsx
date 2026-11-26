import type { ReactNode } from "react";
import { ArrowsInLineVerticalIcon, BellRingingIcon } from "@phosphor-icons/react";
import type { MessagePart } from "@/proto";
import { cn } from "@/lib/cn";

type CompactionPart = Extract<MessagePart, { kind: "compaction" }>;
type WakePart = Extract<MessagePart, { kind: "wake" }>;

/** `84,000` as `84k`. */
function formatTokens(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
    if (n >= 1000) return `${Math.round(n / 1000)}k`;
    return String(n);
}

/** A line across the transcript with a label in the middle. */
function Divider({ icon, children, className }: { icon: ReactNode; children: ReactNode; className?: string }) {
    return (
        <div className={cn("flex items-center gap-3 py-1 text-xs text-muted/85", className)}>
            <span className="h-px flex-1 bg-border" />
            <span className="flex max-w-[80%] min-w-0 items-center gap-1.5">
                {icon}
                <span className="min-w-0 truncate">{children}</span>
            </span>
            <span className="h-px flex-1 bg-border" />
        </div>
    );
}

/** Where the conversation was summarized to free up context. */
export function CompactionDivider({ part }: { part: CompactionPart }) {
    const icon = <ArrowsInLineVerticalIcon className="size-3.5 shrink-0" />;
    const what = part.auto ? "Auto-compacted" : "Compacted";
    switch (part.status) {
        case "running":
            return (
                <Divider icon={icon}>
                    <span className="shimmer">Compacting the conversation</span>
                </Divider>
            );
        case "completed": {
            const counts =
                part.beforeTokens !== undefined && part.afterTokens !== undefined
                    ? ` · ${formatTokens(part.beforeTokens)} → ${formatTokens(part.afterTokens)} tokens`
                    : "";
            return (
                <Divider icon={icon}>
                    {what} the conversation{counts}
                </Divider>
            );
        }
        case "failed":
            return (
                <Divider icon={icon} className="text-danger/90">
                    Compaction failed{part.error ? `: ${part.error}` : ""}
                </Divider>
            );
        case "stopped":
            return <Divider icon={icon}>Compaction stopped</Divider>;
    }
}

const ENDED = { completed: "finished", failed: "failed", stopped: "was stopped" } as const;

/** Opens a reply the agent started on its own, when background work ended. */
export function WakeDivider({ part }: { part: WakePart }) {
    const [first, ...rest] = part.finished;
    const label = first
        ? `${first.description || "Background task"} ${ENDED[first.status]}${rest.length ? ` (+${rest.length} more)` : ""}`
        : "Background work finished";
    return <Divider icon={<BellRingingIcon className="size-3.5 shrink-0" />}>{label}</Divider>;
}
