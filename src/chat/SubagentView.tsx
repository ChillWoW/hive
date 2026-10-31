import { ArrowUpLeftIcon } from "@phosphor-icons/react";
import { type TranscriptMessage, useChatsStore } from "@/chats";
import { cn } from "@/lib/cn";
import type { BackgroundTask, HarnessId } from "@/proto";
import {
    findSpawnIn,
    formatElapsed,
    LiveTasks,
    spawnResult,
    SUBAGENT_STATE,
    SubagentAvatar,
    subagentState,
    Transcript,
    subagentName,
    useSubagent,
    type SpawnPart
} from "@/transcript";
import { Button } from "@/ui";

/**
 * A subagent's own thread in the main pane, as t3code opens one: the task
 * it was given as the prompt, then everything it did and said, live while it
 * runs (a background agent's past its turn). Its bar takes the composer's
 * place (it can't be written to): who it is, how it stands, "Runs on its
 * own", and Open parent to step back up (Back returns too: subagents are
 * places in the chats store's history).
 */
export function SubagentView({
    chatId,
    id,
    messages,
    tasks = [],
    cwd,
    harness
}: {
    chatId: string;
    /** The spawn's tool call id. */
    id: string;
    messages: TranscriptMessage[];
    /** The session's live background tasks. */
    tasks?: BackgroundTask[];
    cwd?: string;
    harness?: HarnessId;
}) {
    const openSubagent = useChatsStore((s) => s.openSubagent);
    const openParent = useChatsStore((s) => s.openParent);

    const found = findSpawnIn(messages, id);
    if (!found) return <Gone onBack={openParent} />;
    const { spawn, message } = found;
    const streaming = message.status === "streaming";
    const live = tasks.some((t) => t.toolCallId === id);
    const running = subagentState(spawn, streaming, live) === "running";

    return (
        <LiveTasks value={tasks}>
            <div className="flex h-full w-full flex-col">
                <Transcript
                    key={`subagent:${id}`}
                    messages={threadMessages(chatId, spawn, message.createdAt, running)}
                    cwd={cwd}
                    harness={harness}
                    onOpenSubagent={(child) => openSubagent(chatId, child)}
                />
                <div className="shrink-0 px-6 pb-3">
                    <div className="mx-auto w-full max-w-3xl">
                        <SubagentBar
                            spawn={spawn}
                            harness={harness}
                            streaming={streaming}
                            onOpenParent={openParent}
                        />
                    </div>
                </div>
            </div>
        </LiveTasks>
    );
}

/** The thread as transcript messages: the task as the prompt, the subagent's work as the reply. */
function threadMessages(
    chatId: string,
    spawn: SpawnPart,
    createdAt: number,
    running: boolean
): TranscriptMessage[] {
    if (spawn.call.kind !== "subagent") return [];
    const thread = spawn.thread ?? [];
    // A harness that reported nothing of its work still has its result.
    const parts =
        !thread.some((p) => p.kind === "text") && spawnResult(spawn)
            ? [...thread, { kind: "text" as const, id: "result", text: spawnResult(spawn) ?? "" }]
            : thread;
    return [
        {
            id: `${spawn.id}:task`,
            chatId,
            role: "user",
            parts: [{ kind: "text", id: "t0", text: spawn.call.prompt || spawn.call.description }],
            createdAt
        },
        {
            id: `${spawn.id}:thread`,
            chatId,
            role: "assistant",
            parts,
            createdAt,
            status: running ? "streaming" : "complete"
        }
    ];
}

function SubagentBar({
    spawn,
    harness,
    streaming,
    onOpenParent
}: {
    spawn: SpawnPart;
    harness?: HarnessId;
    streaming: boolean;
    onOpenParent: () => void;
}) {
    const { state, elapsed } = useSubagent(spawn, streaming);
    const running = state === "running";
    if (spawn.call.kind !== "subagent") return null;

    return (
        <div className="flex min-h-12 items-center gap-3 rounded-[22px] border border-dark-700 bg-dark-850 py-2 ps-3 pe-2 text-sm">
            <SubagentAvatar harness={harness} state={state} />
            <div className="flex min-w-0 flex-1 flex-col sm:flex-row sm:items-center sm:gap-3">
                <span className="min-w-0 truncate font-medium text-dark-50">{subagentName(spawn)}</span>
                <span
                    role="status"
                    className={cn(
                        "min-w-0 truncate text-xs text-dark-200 tabular-nums",
                        state === "failed" && "text-danger"
                    )}
                >
                    {/* Only the label shimmers, on its own width, as tool labels do. */}
                    <span className={cn(running && "shimmer")}>{SUBAGENT_STATE[state].label}</span>
                    {elapsed !== null && ` · ${formatElapsed(elapsed)}`}
                </span>
            </div>
            <span className="hidden shrink-0 text-xs text-dark-250 md:inline">Runs on its own</span>
            <Button size="sm" variant="ghost" onClick={onOpenParent} leftIcon={<ArrowUpLeftIcon className="size-3.5" />}>
                Open parent
            </Button>
        </div>
    );
}

/** The spawn isn't in the transcript (yet, or any more). */
function Gone({ onBack }: { onBack: () => void }) {
    return (
        <div className="flex h-full w-full flex-col items-center justify-center gap-3 text-sm text-dark-200">
            This subagent isn't in the chat.
            <Button size="sm" onClick={onBack} leftIcon={<ArrowUpLeftIcon className="size-3.5" />}>
                Open parent
            </Button>
        </div>
    );
}
