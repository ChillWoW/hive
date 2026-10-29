import {
    ArrowElbowDownRightIcon,
    ChatCircleDotsIcon,
    CircleNotchIcon,
    RobotIcon,
    WarningCircleIcon
} from "@phosphor-icons/react";
import type { FinishedTask, MessagePart } from "@/proto";
import { cn } from "@/lib/cn";
import type { ToolPart } from "./tools";

type Part<K extends MessagePart["kind"]> = Extract<MessagePart, { kind: K }>;

/**
 * A spawned subagent, as a card of its own rather than a line in a tool
 * group, so a running one is visible without opening anything. Its state is
 * shown in the card's own terms: a spinner while it runs, the danger tint
 * if it failed, nothing extra once done.
 */
export function SubagentChip({ part, streaming }: { part: ToolPart; streaming: boolean }) {
    if (part.call.kind !== "subagent") return null;
    const state = part.subagent ?? (part.isError ? "failed" : part.resolved ? "done" : "running");
    // A turn that ended under a running subagent left it unfinished.
    const running = state === "running" && streaming;
    const failed = state === "failed";

    return (
        <div
            className={cn(
                "flex h-[30px] min-w-0 items-center gap-2 rounded-[9px] border border-white/[0.07] bg-white/[0.03] px-2 text-xs",
                failed && "border-danger/25"
            )}
        >
            <span className="flex size-[18px] shrink-0 items-center justify-center rounded-[5px] bg-white/[0.08]">
                <RobotIcon className={cn("size-3", failed ? "text-danger" : "text-dark-200")} />
            </span>
            <span className={cn("shrink-0 font-medium", failed ? "text-danger" : "text-dark-200")}>
                Agent
            </span>
            <span className={cn("min-w-0 flex-1 truncate", failed ? "text-danger" : "text-dark-50/85")}>
                {part.call.description}
            </span>
            {part.call.model && (
                <span className="shrink-0 text-[11px] text-dark-300">{part.call.model}</span>
            )}
            {running && (
                <CircleNotchIcon weight="bold" className="size-3.5 shrink-0 animate-spin text-dark-200" />
            )}
        </div>
    );
}

export function ErrorChip({ message }: { message: string }) {
    return (
        <span className="inline-flex min-h-7 max-w-full items-center gap-1.5 self-start rounded-[9px] border border-danger/25 bg-danger/10 px-2.5 py-1 text-xs text-danger">
            <WarningCircleIcon className="size-3.5 shrink-0" weight="fill" />
            <span className="min-w-0 break-words whitespace-pre-wrap">{message}</span>
        </span>
    );
}

const ENDED: Record<FinishedTask["status"], string> = {
    completed: "finished",
    failed: "failed",
    stopped: "was stopped"
};

/**
 * Opens a reply the agent started on its own: which background work ended
 * and woke it ("After *Run the tests* finished").
 */
export function WakeRow({ part }: { part: Part<"wake"> }) {
    const [first, ...rest] = part.finished;
    const label = !first
        ? "Continued on its own"
        : rest.length === 0
          ? `After`
          : `After ${part.finished.length} background tasks ended`;
    return (
        <div className="flex h-[26px] min-w-0 items-center gap-1.5 text-xs">
            <span className="flex w-[22px] shrink-0 justify-center">
                <ArrowElbowDownRightIcon className="size-3.5 text-dark-200" />
            </span>
            <span className="shrink-0 text-dark-200">{label}</span>
            {first && rest.length === 0 && (
                <>
                    <span className="min-w-0 truncate text-dark-100">{first.description || "a background task"}</span>
                    <span className={cn("shrink-0", first.status === "failed" ? "text-danger" : "text-dark-200")}>
                        {ENDED[first.status]}
                    </span>
                </>
            )}
            {rest.length > 0 && (
                <span className="min-w-0 truncate text-dark-250">
                    {part.finished.map((t) => t.description).join(", ")}
                </span>
            )}
        </div>
    );
}

/** Where the agent asked something: waiting while unanswered (the wizard is below), a line after. */
export function InputRow({ part, streaming }: { part: Part<"input">; streaming: boolean }) {
    const waiting = !part.resolved && streaming;
    const count = part.questions.length;
    const label = part.resolved
        ? `Answered ${count === 1 ? "a question" : `${count} questions`}`
        : waiting
          ? "Waiting for your answer"
          : "Question not answered";
    return (
        <div className="flex h-[26px] min-w-0 items-center gap-1.5 text-xs">
            <span className="flex w-[22px] shrink-0 justify-center">
                <ChatCircleDotsIcon className="size-3.5 text-dark-200" />
            </span>
            <span className={cn("shrink-0 text-dark-200", waiting && "shimmer")}>{label}</span>
            {part.questions[0] && (
                <span className="min-w-0 truncate text-dark-250">{part.questions[0].question}</span>
            )}
        </div>
    );
}
