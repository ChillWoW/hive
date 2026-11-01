import { PlayIcon, TargetIcon, XIcon } from "@phosphor-icons/react";
import type { Goal, GoalStatus } from "@/proto";
import { cn } from "@/lib/cn";
import { trayActionsClassName, trayButtonClassName, trayClassName, trayHeaderClassName } from "./tray";
import { formatTokens } from "@/lib/format";

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

/**
 * The goal the agent keeps working toward (Codex's `/goal`): above the
 * composer, its state ("Pursuing goal" while a turn
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
        <div className={trayClassName}>
            <div className={trayHeaderClassName}>
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
                {spent && <span className="min-w-0 truncate text-dark-250 tabular-nums">· {spent}</span>}
                <span className={trayActionsClassName}>
                    {resumable && (
                        <button type="button" onClick={() => onCommand("resume")} className={trayButtonClassName}>
                            <PlayIcon className="size-3" weight="fill" />
                            Resume
                        </button>
                    )}
                    <button type="button" onClick={() => onCommand("clear")} className={trayButtonClassName}>
                        <XIcon className="size-3" />
                        Clear
                    </button>
                </span>
            </div>
            <p className="line-clamp-2 px-2.5 pb-0.5 text-[13px] text-dark-100">{goal.objective}</p>
        </div>
    );
}
