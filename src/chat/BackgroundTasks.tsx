import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
    CaretRightIcon,
    EyeIcon,
    FlowArrowIcon,
    GearSixIcon,
    RobotIcon,
    StopIcon,
    TerminalWindowIcon,
    type Icon
} from "@phosphor-icons/react";
import { chats, type TranscriptMessage } from "@/chats";
import { chipTriggerClassName, popupClassName } from "@/composer/chip";
import { cn } from "@/lib/cn";
import type { BackgroundTask, BackgroundTaskKind, TaskOutput, ToolCall } from "@/proto";
import { DotMatrixSpinner, Popover, usePortalContainer } from "@/ui";

const ICON: Record<BackgroundTaskKind, Icon> = {
    agent: RobotIcon,
    shell: TerminalWindowIcon,
    monitor: EyeIcon,
    workflow: FlowArrowIcon,
    other: GearSixIcon
};

const NOUN: Record<BackgroundTaskKind, [string, string]> = {
    agent: ["agent", "agents"],
    shell: ["shell", "shells"],
    monitor: ["monitor", "monitors"],
    workflow: ["workflow", "workflows"],
    other: ["task", "tasks"]
};

/** How often an open shell's output is read again. */
const OUTPUT_POLL_MS = 1500;

/** "2 shells", "1 agent", or "3 tasks" for a mix. */
function summary(tasks: BackgroundTask[]): string {
    const mixed = new Set(tasks.map((t) => t.kind)).size > 1;
    const [one, many] = NOUN[mixed ? "other" : tasks[0].kind];
    return `${tasks.length} ${tasks.length === 1 ? one : many}`;
}

/** Each task after the one that launched it, indented under it. */
function nest(tasks: BackgroundTask[]): { task: BackgroundTask; depth: number }[] {
    const ids = new Set(tasks.map((t) => t.id));
    const out: { task: BackgroundTask; depth: number }[] = [];
    const visit = (task: BackgroundTask, depth: number) => {
        out.push({ task, depth });
        if (depth > 3) return;
        for (const child of tasks) if (child.parentId === task.id) visit(child, depth + 1);
    };
    for (const task of tasks) if (!task.parentId || !ids.has(task.parentId)) visit(task, 0);
    return out;
}

function elapsed(since: number | undefined, now: number): string {
    if (since == null) return "";
    const s = Math.max(0, Math.floor((now - since) / 1000));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
    return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

function useNow(enabled: boolean, interval = 1000): number {
    const [now, setNow] = useState(Date.now);
    useEffect(() => {
        if (!enabled) return;
        setNow(Date.now());
        const id = setInterval(() => setNow(Date.now()), interval);
        return () => clearInterval(id);
    }, [enabled, interval]);
    return now;
}

/* eslint-disable no-control-regex -- terminal escape sequences, on purpose */
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const ESC = /\x1b[@-Z\\-_]/g;
/* eslint-enable no-control-regex */

/** Terminal output as plain text: escape sequences out, `\r` rewrites kept. */
function plainText(output: string): string {
    return output
        .replace(OSC, "")
        .replace(CSI, "")
        .replace(ESC, "")
        .split("\n")
        .map((line) => line.split("\r").filter(Boolean).pop() ?? "")
        .join("\n")
        .trimEnd();
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Work the agent left running between turns — subagents, shells, monitors —
 * as a chip under the composer, beside the rings. Click opens the list:
 * each with how long it has run and Stop; a shell opens into the end of its
 * output, read again while it's open. Hidden while nothing runs.
 */
export function BackgroundTasks({
    chatId,
    tasks,
    messages
}: {
    chatId: string;
    tasks: BackgroundTask[] | undefined;
    messages: TranscriptMessage[];
}) {
    const container = usePortalContainer();
    const [open, setOpen] = useState(false);
    // Tool calls by id, for the command a shell runs.
    const calls = useMemo(() => {
        const map = new Map<string, ToolCall>();
        for (const m of messages)
            for (const p of m.parts) if (p.kind === "tool") map.set(p.id, p.call);
        return map;
    }, [messages]);

    if (!tasks?.length) return null;

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <Popover.Trigger
                aria-label={`Background: ${summary(tasks)}`}
                className={cn(chipTriggerClassName, "shrink-0 gap-1.5 px-1.5 text-info")}
            >
                <DotMatrixSpinner interval={400} className="size-2.5" />
                <span className="tabular-nums">{summary(tasks)}</span>
            </Popover.Trigger>
            <Popover.Portal container={container ?? undefined}>
                <Popover.Positioner
                    side="top"
                    align="end"
                    sideOffset={10}
                    collisionPadding={{ top: 48, right: 12, bottom: 12, left: 12 }}
                >
                    <Popover.Popup
                        aria-label="Background tasks"
                        className={cn(popupClassName, "w-[26rem] min-w-0 rounded-xl p-0")}
                    >
                        <TaskList chatId={chatId} tasks={tasks} calls={calls} />
                    </Popover.Popup>
                </Popover.Positioner>
            </Popover.Portal>
        </Popover>
    );
}

function TaskList({
    chatId,
    tasks,
    calls
}: {
    chatId: string;
    tasks: BackgroundTask[];
    calls: Map<string, ToolCall>;
}) {
    const now = useNow(true);
    const [stopping, setStopping] = useState<ReadonlySet<string>>(new Set());
    const [errors, setErrors] = useState<Record<string, string>>({});

    // On success the task leaves the list when the agent reports it stopped.
    const stop = (taskId: string) => {
        setStopping((s) => new Set(s).add(taskId));
        setErrors(({ [taskId]: _, ...rest }) => rest);
        chats.stopTask(chatId, taskId).catch((e) => {
            setStopping((s) => {
                const next = new Set(s);
                next.delete(taskId);
                return next;
            });
            setErrors((errs) => ({ ...errs, [taskId]: errorText(e) }));
        });
    };
    const live = tasks.filter((t) => !stopping.has(t.id));

    return (
        <div className="flex max-h-[min(32rem,var(--available-height))] flex-col">
            <div className="flex h-10 shrink-0 items-center gap-2 pr-2 pl-3">
                <span className="text-[12.5px] font-medium text-dark-50">Background tasks</span>
                <span className="text-[11px] text-dark-300 tabular-nums">{tasks.length} running</span>
                {live.length > 1 && (
                    <button
                        type="button"
                        onClick={() => live.forEach((t) => stop(t.id))}
                        className="ml-auto h-6 rounded-md px-2 text-[11px] text-dark-200 outline-none transition-colors hover:bg-danger/10 hover:text-danger focus-visible:bg-dark-700"
                    >
                        Stop all
                    </button>
                )}
            </div>
            <div className="flex min-h-0 flex-col gap-px overflow-y-auto border-t border-dark-700 p-1.5">
                {nest(tasks).map(({ task, depth }) => (
                    <TaskRow
                        key={task.id}
                        chatId={chatId}
                        task={task}
                        depth={depth}
                        call={task.toolCallId ? calls.get(task.toolCallId) : undefined}
                        now={now}
                        stopping={stopping.has(task.id)}
                        error={errors[task.id]}
                        onStop={() => stop(task.id)}
                    />
                ))}
            </div>
        </div>
    );
}

/** The row's second line: a shell's command, else what kind of task it is. */
function detailOf(task: BackgroundTask, call: ToolCall | undefined): string | undefined {
    if (call?.kind === "exec") return `$ ${call.command}`;
    switch (task.kind) {
        case "agent":
            return task.agentType && task.agentType !== "general-purpose"
                ? `Subagent · ${task.agentType}`
                : "Subagent";
        case "shell":
            return "Shell";
        case "monitor":
            return "Monitor";
        case "workflow":
            return "Workflow";
        default:
            return undefined;
    }
}

function TaskRow({
    chatId,
    task,
    depth,
    call,
    now,
    stopping,
    error,
    onStop
}: {
    chatId: string;
    task: BackgroundTask;
    depth: number;
    call: ToolCall | undefined;
    now: number;
    stopping: boolean;
    error: string | undefined;
    onStop: () => void;
}) {
    const [expanded, setExpanded] = useState(false);
    const Glyph = ICON[task.kind];
    const readable = task.kind === "shell" || task.kind === "monitor";
    const title = task.description || NOUN[task.kind][0];
    const detail = detailOf(task, call);
    const indent = depth * 16;

    return (
        <div className="flex flex-col">
            <div
                className={cn(
                    "group/task relative flex items-center gap-2.5 rounded-lg py-1.5 pr-1.5 transition-colors duration-100",
                    readable && "hover:bg-dark-800 has-[>button:focus-visible]:bg-dark-800",
                    stopping && "opacity-60"
                )}
                style={{ paddingLeft: 6 + indent }}
            >
                {/* The whole row opens a shell's output; Stop sits above it. */}
                {readable && (
                    <button
                        type="button"
                        aria-expanded={expanded}
                        aria-label={`${expanded ? "Hide" : "Show"} output of ${title}`}
                        onClick={() => setExpanded((v) => !v)}
                        className="absolute inset-0 rounded-lg outline-none"
                    />
                )}
                <span className="grid size-7 shrink-0 place-items-center rounded-md border border-dark-700 bg-dark-850 text-dark-100">
                    <Glyph className="size-3.5" />
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-px">
                    <span className="truncate text-[12.5px] text-dark-50">{title}</span>
                    {detail && (
                        <span
                            className={cn(
                                "truncate text-[11px] text-dark-300",
                                call?.kind === "exec" && "font-mono text-[10.5px]"
                            )}
                        >
                            {detail}
                        </span>
                    )}
                </span>
                <span className="pointer-events-none relative z-10 flex shrink-0 items-center gap-0.5">
                    {stopping ? (
                        <span className="px-1 text-[11px] text-dark-300">Stopping…</span>
                    ) : (
                        <>
                            <span className="px-1 text-[11px] text-dark-300 tabular-nums group-hover/task:hidden group-focus-within/task:hidden">
                                {elapsed(task.startedAt, now)}
                            </span>
                            <button
                                type="button"
                                aria-label={`Stop ${title}`}
                                onClick={onStop}
                                className={cn(
                                    "pointer-events-auto hidden h-6 items-center gap-1 rounded-md px-2 text-[11px] text-dark-100 outline-none",
                                    "bg-dark-700 transition-colors hover:bg-danger/15 hover:text-danger focus-visible:bg-danger/15 focus-visible:text-danger",
                                    "group-hover/task:inline-flex group-focus-within/task:inline-flex"
                                )}
                            >
                                <StopIcon weight="fill" className="size-2.5" />
                                Stop
                            </button>
                        </>
                    )}
                    <span className="grid w-4 place-items-center">
                        {readable && (
                            <CaretRightIcon
                                className={cn(
                                    "size-3 text-dark-300 transition-transform duration-150",
                                    expanded && "rotate-90"
                                )}
                            />
                        )}
                    </span>
                </span>
            </div>
            {error && (
                <div className="pb-1 text-[11px] text-danger" style={{ paddingLeft: 44 + indent }}>
                    {error}
                </div>
            )}
            {expanded && <OutputTail chatId={chatId} taskId={task.id} indent={indent} />}
        </div>
    );
}

/** The end of a shell's output, read again while shown; pinned to the bottom. */
function OutputTail({ chatId, taskId, indent }: { chatId: string; taskId: string; indent: number }) {
    const [output, setOutput] = useState<TaskOutput | null>(null);
    const [error, setError] = useState<string | null>(null);
    const ref = useRef<HTMLPreElement>(null);
    const pinned = useRef(true);

    useEffect(() => {
        let alive = true;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const read = () => {
            chats
                .taskOutput(chatId, taskId)
                .then(
                    (next) => {
                        if (!alive) return;
                        setOutput(next);
                        setError(null);
                    },
                    (e) => alive && setError(errorText(e))
                )
                .finally(() => {
                    if (alive) timer = setTimeout(read, OUTPUT_POLL_MS);
                });
        };
        read();
        return () => {
            alive = false;
            clearTimeout(timer);
        };
    }, [chatId, taskId]);

    const text = useMemo(() => (output ? plainText(output.output) : ""), [output]);

    useLayoutEffect(() => {
        const el = ref.current;
        if (el && pinned.current) el.scrollTop = el.scrollHeight;
    }, [text]);

    return (
        <div className="flex flex-col gap-1 pt-1 pr-1.5 pb-1.5" style={{ paddingLeft: 44 + indent }}>
            <pre
                ref={ref}
                onScroll={(e) => {
                    const el = e.currentTarget;
                    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
                }}
                className={cn(
                    "max-h-56 overflow-auto rounded-md border border-dark-700 bg-dark-900 px-2.5 py-2",
                    "font-mono text-[11px] leading-[1.5] break-all whitespace-pre-wrap",
                    text ? "text-dark-100" : "text-dark-300"
                )}
            >
                {text || (error ? "" : output ? "No output yet." : "Reading…")}
            </pre>
            {error && <span className="text-[11px] text-danger">{error}</span>}
            {output?.truncated && (
                <span className="text-[11px] text-dark-300">
                    Last 8 KB of {Math.round(output.totalBytes / 1024).toLocaleString("en-US")} KB
                </span>
            )}
        </div>
    );
}
