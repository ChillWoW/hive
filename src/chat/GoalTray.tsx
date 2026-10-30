import { PlayIcon, TargetIcon, XIcon } from "@phosphor-icons/react";
import type { Goal, GoalStatus } from "@/proto";
import { cn } from "@/lib/cn";
import { formatTokens } from "@/usage/format";

const TITLE: Record<GoalStatus, string> = {
    active: "Goal set",
    paused: "Goal paused",
    blocked: "Goal blocked",
    usageLimited: "Goal hit a usage limit",
    budgetLimited: "Goal reached its token budget",
    complete: "Goal complete"
};

function duration(seconds: number): string {
    const m = Math.floor(seconds / 60);
    if (m < 60) return `${m}m`;
    return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** "12K tokens · 5m", "12K / 50K tokens"; the time once it's a minute. */
function usage(goal: Goal): string {
    const tokens =
        goal.tokenBudget != null
            ? `${formatTokens(goal.tokensUsed)} / ${formatTokens(goal.tokenBudget)} tokens`
            : goal.tokensUsed > 0
              ? `${formatTokens(goal.tokensUsed)} tokens`
              : "";
    return [tokens, goal.secondsUsed >= 60 ? duration(goal.secondsUsed) : ""]
        .filter(Boolean)
        .join(" · ");
}

const buttonClassName = cn(
    "inline-flex h-5 shrink-0 items-center gap-1 rounded-md px-1.5 text-dark-200 outline-none",
    "transition-colors hover:bg-dark-700 hover:text-dark-50 focus-visible:bg-dark-700"
);

/**
 * The goal the agent keeps working toward (Codex's `/goal`), as t3code
 * shows it: above the composer, its state ("Pursuing goal" while a turn
 * runs), the objective and what it has used so far. Resume (when it
 * stopped short) and Clear send `/goal resume` and `/goal clear`.
 */
export function GoalTray({
    goal,
    working,
    onCommand
}: {
    goal: Goal;
    /** A turn is running. */
    working: boolean;
    /** Sends `/goal <arg>`. */
    onCommand: (arg: "resume" | "clear") => void;
}) {
    const title = goal.status === "active" && working ? "Pursuing goal" : TITLE[goal.status];
    const spent = usage(goal);
    const resumable = goal.status !== "active" && goal.status !== "complete" && !working;
    return (
        <div
            className={cn(
                "mx-4 rounded-t-2xl border border-b-0 border-dark-700 bg-dark-900 px-1 pt-1 pb-1.5",
                "transition-[opacity,translate] duration-200 ease-out starting:translate-y-2 starting:opacity-0"
            )}
        >
            <div className="flex h-6 min-w-0 items-center gap-1.5 px-2.5 text-xs">
                <TargetIcon
                    className={cn(
                        "size-3.5 shrink-0",
                        goal.status === "complete" ? "text-success" : "text-dark-200"
                    )}
                />
                <span
                    className={cn(
                        "shrink-0 font-medium text-dark-200",
                        goal.status === "active" && working && "shimmer"
                    )}
                >
                    {title}
                </span>
                {spent && <span className="shrink-0 text-dark-250 tabular-nums">· {spent}</span>}
                <span className="ml-auto flex shrink-0 items-center gap-0.5 -mr-1.5">
                    {resumable && (
                        <button type="button" onClick={() => onCommand("resume")} className={buttonClassName}>
                            <PlayIcon className="size-3" weight="fill" />
                            Resume
                        </button>
                    )}
                    <button type="button" onClick={() => onCommand("clear")} className={buttonClassName}>
                        <XIcon className="size-3" />
                        Clear
                    </button>
                </span>
            </div>
            <p className="line-clamp-2 px-2.5 pb-0.5 text-[13px] text-dark-100">{goal.objective}</p>
        </div>
    );
}
