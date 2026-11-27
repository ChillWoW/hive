import { useMemo, useState } from "react";
import { Popover } from "@base-ui/react/popover";
import { CaretRightIcon, RobotIcon, TerminalWindowIcon, WaveformIcon, type Icon } from "@phosphor-icons/react";
import type { BackgroundTask, BackgroundTaskKind, Message, ToolCall } from "@/proto";
import { cn } from "@/lib/cn";
import { formatElapsed, useNow } from "@/lib/time";
import { chats, taskStartedAt } from "@/features/chats/store";
import { ActiveHarnessMark } from "@/features/models/ActiveHarnessMark";
import { DotMatrixSpinner } from "@/ui";
import { chipTriggerClassName, popupClassName } from "@/ui/chip";
import { findSpawnIn, progressLine } from "./transcript/subagents";
import type { ToolPart } from "./transcript/tools";

const KINDS: Record<BackgroundTaskKind, { icon: Icon; label: string }> = {
    agent: { icon: RobotIcon, label: "Agent" },
    shell: { icon: TerminalWindowIcon, label: "Shell" },
    monitor: { icon: WaveformIcon, label: "Monitor" },
    other: { icon: TerminalWindowIcon, label: "Task" }
};

/**
 * Work the agent left running between turns, as a chip in the row under the
 * composer: a dot matrix and how many run. Click opens the list: each task
 * with what it runs (an agent, what it last said), how long it has run, and
 * Stop; an agent's row opens its thread. Hidden while nothing runs.
 */
export function BackgroundTasks({
    tasks,
    messages,
    onStop
}: {
    tasks: BackgroundTask[];
    messages: Message[];
    onStop: (taskId: string) => void;
}) {
    const [open, setOpen] = useState(false);
    if (tasks.length === 0) return null;
    return (
        <Popover.Root open={open} onOpenChange={setOpen}>
            <Popover.Trigger
                aria-label={`Background tasks: ${tasks.length} running`}
                className={cn(chipTriggerClassName, "shrink-0 text-info hover:bg-info/12 hover:text-info data-[popup-open]:bg-info/12 data-[popup-open]:text-info")}
            >
                <DotMatrixSpinner interval={400} label="Running" className="size-2.5" />
                <span className="tabular-nums">{tasks.length} running</span>
            </Popover.Trigger>
            <Popover.Portal>
                <Popover.Positioner side="top" align="end" sideOffset={8} collisionPadding={12}>
                    <Popover.Popup aria-label="Background tasks" className={cn(popupClassName, "w-80")}>
                        <TaskList
                            tasks={tasks}
                            messages={messages}
                            onStop={onStop}
                            onOpenAgent={(id) => {
                                setOpen(false);
                                chats.openSubagent(id);
                            }}
                        />
                    </Popover.Popup>
                </Popover.Positioner>
            </Popover.Portal>
        </Popover.Root>
    );
}

function TaskList({
    tasks,
    messages,
    onStop,
    onOpenAgent
}: {
    tasks: BackgroundTask[];
    messages: Message[];
    onStop: (taskId: string) => void;
    onOpenAgent: (spawnId: string) => void;
}) {
    const now = useNow();
    // Stopped ones leave when the session says so; till then they read "Stopping".
    const [stopping, setStopping] = useState<ReadonlySet<string>>(new Set());
    const stop = (id: string) => {
        setStopping((s) => new Set(s).add(id));
        onStop(id);
    };
    // Tool calls by id: a shell's command, an agent's spawn.
    const calls = useMemo(() => {
        const map = new Map<string, ToolCall>();
        for (const m of messages) for (const p of m.parts) if (p.kind === "tool") map.set(p.id, p.call);
        return map;
    }, [messages]);
    const live = tasks.filter((t) => !stopping.has(t.id));

    return (
        <div className="flex max-h-[min(24rem,var(--available-height))] flex-col">
            <div className="flex h-8 shrink-0 items-center gap-1.5 pr-1.5 pl-3 text-[11px] text-muted">
                <span className="font-medium text-text/85">Background</span>
                <span className="tabular-nums">{tasks.length}</span>
                {live.length > 1 && (
                    <button
                        type="button"
                        onClick={() => live.forEach((t) => stop(t.id))}
                        className="ml-auto inline-flex h-6 items-center gap-1.5 rounded-md px-2 outline-none transition-colors hover:bg-danger/10 hover:text-danger focus-visible:bg-danger/10 focus-visible:text-danger"
                    >
                        <span className="size-2 rounded-[2px] bg-current" />
                        Stop all
                    </button>
                )}
            </div>
            <div className="flex min-h-0 flex-col gap-px overflow-y-auto px-1 pb-1">
                {tasks.map((task) => {
                    const call = task.toolCallId ? calls.get(task.toolCallId) : undefined;
                    const spawn =
                        task.kind === "agent" && task.toolCallId
                            ? findSpawnIn(messages, task.toolCallId)?.spawn
                            : undefined;
                    return (
                        <TaskRow
                            key={task.id}
                            task={task}
                            call={call}
                            spawn={spawn}
                            now={now}
                            stopping={stopping.has(task.id)}
                            onStop={() => stop(task.id)}
                            onOpen={spawn ? () => onOpenAgent(spawn.id) : undefined}
                        />
                    );
                })}
            </div>
        </div>
    );
}

function TaskRow({
    task,
    call,
    spawn,
    now,
    stopping,
    onStop,
    onOpen
}: {
    task: BackgroundTask;
    call: ToolCall | undefined;
    spawn: ToolPart | undefined;
    now: number;
    stopping: boolean;
    onStop: () => void;
    onOpen?: () => void;
}) {
    const kind = KINDS[task.kind];
    const command = call?.kind === "exec" ? call.command : undefined;
    const title = task.description || command || task.agentType || kind.label;
    // An agent: what it last said; a shell: its command under its description.
    const detail =
        task.kind === "agent"
            ? (progressLine(spawn?.thread) ?? task.agentType ?? kind.label)
            : command && command !== title
              ? command
              : kind.label;
    const mono = task.kind !== "agent" && detail === command;
    const started = spawn?.startedAt ?? taskStartedAt(task.id);
    const Glyph = kind.icon;

    return (
        <div
            className={cn(
                "group/task relative flex items-center gap-2.5 rounded-md py-1.5 pr-1 pl-2 transition-colors",
                onOpen && "hover:bg-hover/60 has-[>button:focus-visible]:bg-hover/60",
                stopping && "opacity-60"
            )}
        >
            {/* The whole row opens an agent; Stop sits above it. */}
            {onOpen && (
                <button
                    type="button"
                    aria-label={`Open ${title}`}
                    onClick={onOpen}
                    className="absolute inset-0 cursor-pointer rounded-md outline-none"
                />
            )}
            <span className="pointer-events-none relative inline-flex size-6 shrink-0 items-center justify-center rounded-full border border-border bg-bg">
                {task.kind === "agent" ? (
                    <ActiveHarnessMark className="size-3.5" />
                ) : (
                    <Glyph className="size-3.5 text-muted" />
                )}
                <span className="absolute -right-1 -bottom-1 grid size-3 place-items-center rounded-full bg-surface text-info">
                    <DotMatrixSpinner interval={400} label="Running" className="size-[7px] gap-[0.5px]" />
                </span>
            </span>
            <span className="pointer-events-none flex min-w-0 flex-1 flex-col">
                <span className="truncate text-xs font-medium text-text">{title}</span>
                <span className={cn("truncate text-[11px] leading-relaxed text-muted", mono && "font-mono")}>
                    {detail}
                </span>
            </span>
            <span className="pointer-events-none relative z-10 flex shrink-0 items-center gap-0.5">
                <span className="px-1 text-[11px] text-muted tabular-nums">
                    {stopping ? "Stopping…" : started !== undefined && formatElapsed(now - started)}
                </span>
                <button
                    type="button"
                    aria-label={`Stop ${title}`}
                    disabled={stopping}
                    onClick={onStop}
                    className="pointer-events-auto grid size-6 place-items-center rounded-md text-muted outline-none transition-colors hover:bg-danger/10 hover:text-danger focus-visible:bg-danger/10 focus-visible:text-danger disabled:pointer-events-none disabled:opacity-0"
                >
                    <span className="size-2 rounded-[2px] bg-current" />
                </button>
                <span className="grid w-3.5 place-items-center text-muted/70">
                    {onOpen && <CaretRightIcon className="size-3" />}
                </span>
            </span>
        </div>
    );
}
