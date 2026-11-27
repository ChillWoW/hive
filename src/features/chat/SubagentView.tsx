import { ArrowUpLeftIcon } from "@phosphor-icons/react";
import type { Message } from "@/proto";
import { cn } from "@/lib/cn";
import { formatElapsed } from "@/lib/time";
import { chats } from "@/features/chats/store";
import { Button } from "@/ui";
import { laneClassName, TranscriptScroller } from "./ChatView";
import { AssistantMessage } from "./transcript/AssistantMessage";
import { SubagentAvatar } from "./transcript/Subagent";
import { findSpawnIn, spawnResult, SUBAGENT_STATE, subagentName, useSubagent } from "./transcript/subagents";
import type { ToolPart } from "./transcript/tools";
import { UserMessage } from "./transcript/UserMessage";

/**
 * A subagent's own thread in the main pane: the task it was given as the
 * prompt, then everything it did and said, live while it runs (a background
 * agent's past its turn). The bar under it takes the composer's place (a subagent can't be
 * written to): who it is, how it stands, and Open parent to step back up.
 */
export function SubagentView({
    id,
    messages
}: {
    /** The spawn's tool call id. */
    id: string;
    messages: Message[];
}) {
    const found = findSpawnIn(messages, id);
    if (!found) return <Gone />;
    const { spawn, message } = found;
    return (
        <div className="flex min-h-0 w-full flex-1 flex-col">
            <ThreadTranscript key={id} spawn={spawn} message={message} />
            <div className="shrink-0 px-6 pb-3">
                <div className={laneClassName}>
                    <SubagentBar spawn={spawn} streaming={message.status === "streaming"} />
                </div>
            </div>
        </div>
    );
}

function ThreadTranscript({ spawn, message }: { spawn: ToolPart; message: Message }) {
    const { state } = useSubagent(spawn, message.status === "streaming");
    const [task, reply] = threadMessages(spawn, message.createdAt, state === "running");
    return (
        <TranscriptScroller follow={spawn}>
            <UserMessage message={task} />
            <AssistantMessage message={reply} />
        </TranscriptScroller>
    );
}

/** The thread as transcript messages: the task as the prompt, the subagent's work as the reply. */
function threadMessages(spawn: ToolPart, fallbackStart: number, running: boolean): [Message, Message] {
    const call = spawn.call;
    const prompt = call.kind === "subagent" ? call.prompt || call.description : "";
    const thread = spawn.thread ?? [];
    // A harness that reported nothing of its work still has its result.
    const result = spawnResult(spawn);
    const parts =
        result && !thread.some((p) => p.kind === "text")
            ? [...thread, { kind: "text" as const, id: `${spawn.id}:result`, text: result }]
            : thread;
    const createdAt = spawn.startedAt ?? fallbackStart;
    return [
        {
            id: `${spawn.id}:task`,
            role: "user",
            parts: [{ kind: "text", id: `${spawn.id}:prompt`, text: prompt }],
            createdAt
        },
        {
            id: `${spawn.id}:thread`,
            role: "assistant",
            parts,
            createdAt,
            status: running ? "streaming" : "complete",
            durationMs: !running && spawn.endedAt !== undefined ? spawn.endedAt - createdAt : undefined
        }
    ];
}

/** Under the thread, in the composer's place: who the subagent is, how it stands, and the way back up. */function SubagentBar({ spawn, streaming }: { spawn: ToolPart; streaming: boolean }) {
    const { state, elapsed } = useSubagent(spawn, streaming);
    const running = state === "running";
    return (
        <div className="flex min-h-12 items-center gap-3 rounded-[22px] border border-border bg-surface py-2 ps-3 pe-2 text-sm">
            <SubagentAvatar state={state} />
            <div className="flex min-w-0 flex-1 flex-col sm:flex-row sm:items-center sm:gap-3">
                <span className="min-w-0 truncate font-medium text-text">{subagentName(spawn)}</span>
                <span
                    role="status"
                    className={cn("min-w-0 truncate text-xs text-muted tabular-nums", state === "failed" && "text-danger")}
                >
                    {/* Only the label shimmers, on its own width, as tool labels do. */}
                    <span className={cn(running && "shimmer")}>{SUBAGENT_STATE[state].label}</span>
                    {elapsed !== null && ` · ${formatElapsed(elapsed, { round: true })}`}
                </span>
            </div>
            <Button size="sm" variant="ghost" className="rounded-full" onClick={() => chats.openSubagentDepth(-1)}>
                <ArrowUpLeftIcon className="size-3.5" />
                Open parent
            </Button>
        </div>
    );
}

/** The spawn isn't in the transcript (yet, or any more). */
function Gone() {
    return (
        <div className="flex h-full w-full flex-col items-center justify-center gap-3 text-sm text-muted">
            This subagent isn't in the chat.
            <Button size="sm" variant="secondary" onClick={() => chats.openSubagentDepth(0)}>
                <ArrowUpLeftIcon className="size-3.5" />
                Back to chat
            </Button>
        </div>
    );
}
