import { useEffect } from "react";
import { cn } from "@/lib/cn";
import { activeFilter, present, useStatuses } from "./groups";
import type { LiveStatus } from "./status";
import { StatusMark } from "./StatusMark";
import { useSidebarStore } from "./store";

const WORDS: Record<LiveStatus, string> = {
    asking: "needs you",
    working: "working",
    unread: "unread"
};

/**
 * What's going on across every project, in a line: how many chats need the
 * user, are working, or have unread replies. Each count is a toggle that
 * narrows the list to those chats. Gone while every chat is idle.
 */
export function StatusFilter() {
    const { counts } = useStatuses();
    const picked = useSidebarStore((s) => s.filter);
    const setFilter = useSidebarStore((s) => s.setFilter);
    const filter = activeFilter(picked, counts);

    // Its last chat settled: don't come back on when another gets the status.
    useEffect(() => {
        if (picked && !filter) setFilter(null);
    }, [picked, filter, setFilter]);

    const shown = present(counts);
    if (!shown.length) return null;

    return (
        <div role="group" aria-label="Show only" className="flex shrink-0 flex-wrap gap-1 px-2 pb-1">
            {shown.map((status) => (
                <button
                    key={status}
                    type="button"
                    aria-pressed={filter === status}
                    onClick={() => setFilter(filter === status ? null : status)}
                    className={cn(
                        "flex h-6 items-center gap-1 rounded-md pr-2 pl-1 text-[11px] outline-none",
                        "transition-colors duration-100 focus-visible:ring-1 focus-visible:ring-muted/50",
                        filter === status
                            ? "bg-hover text-text"
                            : "text-muted hover:bg-raised hover:text-text"
                    )}
                >
                    <StatusMark status={status} />
                    <span className={cn("tabular-nums", status === "working" && "shimmer")}>
                        {counts[status]} {WORDS[status]}
                    </span>
                </button>
            ))}
        </div>
    );
}
