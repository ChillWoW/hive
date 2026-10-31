import {
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
    type KeyboardEvent,
    type ReactNode
} from "react";
import {
    CaretDownIcon,
    CaretRightIcon,
    CheckIcon,
    CopyIcon,
    EyeIcon,
    FlowArrowIcon,
    GearSixIcon,
    RobotIcon,
    TerminalWindowIcon,
    type Icon
} from "@phosphor-icons/react";
import { chats, type TranscriptMessage } from "@/chats";
import { chipTriggerClassName, popupClassName } from "@/composer/chip";
import { HarnessIcon } from "@/harnesses";
import { cn } from "@/lib/cn";
import type { BackgroundTask, BackgroundTaskKind, HarnessId, TaskOutput, ToolCall } from "@/proto";
import { findSpawnIn, progressLine, useSubagentStore, type SpawnPart } from "@/transcript/subagents";
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

/** The list's sections, in order. */
const SECTIONS: { kind: BackgroundTaskKind; title: string }[] = [
    { kind: "agent", title: "Agents" },
    { kind: "shell", title: "Shells" },
    { kind: "monitor", title: "Monitors" },
    { kind: "workflow", title: "Workflows" },
    { kind: "other", title: "Other" }
];

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
 * as a chip under the composer, beside the rings. Click opens the list,
 * grouped by kind: an agent as in the transcript (avatar, what it's doing),
 * opening its thread; a shell by its command, opening into the end of its
 * output, read again while it's open. Each with how long it has run and
 * Stop. ↑↓ move between rows, Enter opens one, Backspace stops it. Hidden
 * while nothing runs.
 */
export function BackgroundTasks({
    chatId,
    harness,
    tasks,
    messages
}: {
    chatId: string;
    harness: HarnessId;
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
                        className={cn(popupClassName, "w-[22.5rem] min-w-0 rounded-xl p-0")}
                    >
                        <TaskList
                            chatId={chatId}
                            harness={harness}
                            tasks={tasks}
                            calls={calls}
                            messages={messages}
                            onOpenAgent={(id) => {
                                setOpen(false);
                                useSubagentStore.getState().openSubagent(chatId, id);
                            }}
                        />
                    </Popover.Popup>
                </Popover.Positioner>
            </Popover.Portal>
        </Popover>
    );
}

function TaskList({
    chatId,
    harness,
    tasks,
    calls,
    messages,
    onOpenAgent
}: {
    chatId: string;
    harness: HarnessId;
    tasks: BackgroundTask[];
    calls: Map<string, ToolCall>;
    messages: TranscriptMessage[];
    onOpenAgent: (spawnId: string) => void;
}) {
    const now = useNow(true);
    const [stopping, setStopping] = useState<ReadonlySet<string>>(new Set());
    const [errors, setErrors] = useState<Record<string, string>>({});

    // On success the task leaves the list when the agent reports it stopped.
    const stop = (taskId: string) => {
        if (stopping.has(taskId)) return;
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
    const sections = SECTIONS.map((s) => ({ ...s, tasks: tasks.filter((t) => t.kind === s.kind) })).filter(
        (s) => s.tasks.length
    );

    // ↑↓ move between rows, Backspace/Delete stops the focused one.
    const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
        const rows = [...e.currentTarget.querySelectorAll<HTMLElement>("[data-task-row]")];
        const at = rows.indexOf(document.activeElement as HTMLElement);
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            const step = e.key === "ArrowDown" ? 1 : -1;
            const next = at < 0 ? (step > 0 ? 0 : rows.length - 1) : (at + step + rows.length) % rows.length;
            rows[next]?.focus();
        } else if ((e.key === "Backspace" || e.key === "Delete") && at >= 0) {
            e.preventDefault();
            const id = rows[at].dataset.taskRow;
            if (id) stop(id);
        }
    };

    return (
        <div className="flex max-h-[min(32rem,var(--available-height))] flex-col">
            <div className="flex min-h-0 flex-col overflow-y-auto pb-1" onKeyDown={onKeyDown}>
                {sections.map((section) => (
                    <section key={section.kind} className="flex flex-col">
                        <div className="flex items-center gap-1.5 px-3 pt-2.5 pb-1 text-[11px] text-dark-250">
                            <span className="font-medium text-dark-200">{section.title}</span>
                            <span className="tabular-nums">{section.tasks.length}</span>
                        </div>
                        <div className="flex flex-col gap-px px-1">
                            {nest(section.tasks).map(({ task, depth }) => (
                                <TaskRow
                                    key={task.id}
                                    chatId={chatId}
                                    harness={harness}
                                    task={task}
                                    depth={depth}
                                    call={task.toolCallId ? calls.get(task.toolCallId) : undefined}
                                    spawn={
                                        task.kind === "agent" && task.toolCallId
                                            ? findSpawnIn(messages, task.toolCallId)?.spawn
                                            : undefined
                                    }
                                    now={now}
                                    stopping={stopping.has(task.id)}
                                    error={errors[task.id]}
                                    onStop={() => stop(task.id)}
                                    onOpenAgent={onOpenAgent}
                                />
                            ))}
                        </div>
                    </section>
                ))}
            </div>
            <div className="flex h-9 shrink-0 items-center gap-2 border-t border-dark-700 pr-1.5 pl-3 text-[11px] text-dark-250">
                <span className="min-w-0 flex-1 truncate">Runs between turns</span>
                {live.length > 1 && (
                    <button
                        type="button"
                        onClick={() => live.forEach((t) => stop(t.id))}
                        className="inline-flex h-6 items-center gap-1.5 rounded-md px-2 text-dark-200 outline-none transition-colors hover:bg-danger/10 hover:text-danger focus-visible:bg-danger/10 focus-visible:text-danger"
                    >
                        <span className="size-2 rounded-[2px] bg-current" />
                        Stop all
                    </button>
                )}
            </div>
        </div>
    );
}

/** A shell's command as the title, else the task's own description. */
function titleOf(task: BackgroundTask, call: ToolCall | undefined): { text: string; mono: boolean } {
    if (task.kind !== "agent" && call?.kind === "exec") return { text: call.command, mono: true };
    return { text: task.description || NOUN[task.kind][0], mono: false };
}

/** The row's second line for anything but an agent. */
function detailOf(task: BackgroundTask, call: ToolCall | undefined): string | undefined {
    // A shell titled by its command keeps its description under it.
    if (call?.kind === "exec") return task.description && task.description !== call.command ? task.description : undefined;
    switch (task.kind) {
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

/** The tool calls a subagent has made so far. */
function toolCount(spawn: SpawnPart | undefined): number {
    return spawn?.thread?.filter((p) => p.kind === "tool").length ?? 0;
}

function TaskRow({
    chatId,
    harness,
    task,
    depth,
    call,
    spawn,
    now,
    stopping,
    error,
    onStop,
    onOpenAgent
}: {
    chatId: string;
    harness: HarnessId;
    task: BackgroundTask;
    depth: number;
    call: ToolCall | undefined;
    spawn: SpawnPart | undefined;
    now: number;
    stopping: boolean;
    error: string | undefined;
    onStop: () => void;
    onOpenAgent: (spawnId: string) => void;
}) {
    const [expanded, setExpanded] = useState(false);
    const agent = task.kind === "agent";
    const readable = task.kind === "shell" || task.kind === "monitor";
    const openable = agent && !!spawn;
    const { text: title, mono } = titleOf(task, call);
    const indent = depth * 16;

    let detail: ReactNode;
    if (agent) {
        const line = progressLine(spawn?.thread);
        const tools = toolCount(spawn);
        detail = (
            <>
                <span className="shimmer">{line ?? "Working"}</span>
                {tools > 0 && ` · ${tools} ${tools === 1 ? "tool" : "tools"}`}
            </>
        );
    } else {
        detail = detailOf(task, call);
    }

    const action = openable
        ? { label: `Open ${title}`, run: () => onOpenAgent(spawn.id) }
        : readable
          ? { label: `${expanded ? "Hide" : "Show"} output of ${title}`, run: () => setExpanded((v) => !v) }
          : null;

    return (
        <div className="flex flex-col">
            <div
                className={cn(
                    "group/task relative flex items-center gap-2.5 rounded-md py-1.5 pr-1 transition-colors duration-100",
                    action && "hover:bg-white/[0.04] has-[>button:focus-visible]:bg-white/[0.05]",
                    stopping && "opacity-60"
                )}
                style={{ paddingLeft: 8 + indent }}
            >
                {/* The whole row is the button; Stop sits above it. */}
                <button
                    type="button"
                    data-task-row={task.id}
                    aria-expanded={readable ? expanded : undefined}
                    aria-label={action?.label ?? title}
                    onClick={action?.run}
                    className={cn("absolute inset-0 rounded-md outline-none", !action && "cursor-default")}
                />
                <TaskAvatar task={task} harness={harness} />
                <span className="pointer-events-none flex min-w-0 flex-1 flex-col">
                    <span
                        className={cn(
                            "truncate text-xs text-dark-50",
                            mono ? "font-mono text-[11px]" : "font-medium"
                        )}
                    >
                        {title}
                    </span>
                    {detail && <span className="truncate text-[11px] leading-relaxed text-dark-200">{detail}</span>}
                </span>
                <span className="pointer-events-none relative z-10 flex shrink-0 items-center gap-0.5">
                    <span className="px-1 text-[11px] text-dark-200 tabular-nums">
                        {stopping ? "Stopping…" : elapsed(task.startedAt, now)}
                    </span>
                    <button
                        type="button"
                        aria-label={`Stop ${title}`}
                        tabIndex={-1}
                        disabled={stopping}
                        onClick={onStop}
                        className="pointer-events-auto grid size-6 place-items-center rounded-md text-dark-250 outline-none transition-colors hover:bg-danger/10 hover:text-danger disabled:pointer-events-none disabled:opacity-0"
                    >
                        <span className="size-2 rounded-[2px] bg-current" />
                    </button>
                    <span className="grid w-3.5 place-items-center text-dark-250">
                        {openable && <CaretRightIcon className="size-3" />}
                        {readable &&
                            (expanded ? <CaretDownIcon className="size-3" /> : <CaretRightIcon className="size-3" />)}
                    </span>
                </span>
            </div>
            {error && (
                <div className="pb-1 text-[11px] text-danger" style={{ paddingLeft: 42 + indent }}>
                    {error}
                </div>
            )}
            {expanded && <OutputTail chatId={chatId} taskId={task.id} indent={indent} />}
        </div>
    );
}

/** A round avatar as the transcript's subagents have, a live dot matrix on its corner. */
function TaskAvatar({ task, harness }: { task: BackgroundTask; harness: HarnessId }) {
    const Glyph = ICON[task.kind];
    return (
        <span className="pointer-events-none relative inline-flex size-6 shrink-0 items-center justify-center rounded-full border border-dark-600 bg-dark-800">
            {task.kind === "agent" ? (
                <HarnessIcon harness={harness} className="size-3.5" />
            ) : (
                <Glyph className="size-3.5 text-dark-200" />
            )}
            <span className="absolute -right-1 -bottom-1 grid size-3 place-items-center rounded-full bg-dark-850 text-info">
                <DotMatrixSpinner interval={400} label="Running" className="size-[7px] gap-[0.5px]" />
            </span>
        </span>
    );
}

/** The end of a shell's output, read again while shown; pinned to the bottom. */
function OutputTail({ chatId, taskId, indent }: { chatId: string; taskId: string; indent: number }) {
    const [output, setOutput] = useState<TaskOutput | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);
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

    useEffect(() => {
        if (!copied) return;
        const t = setTimeout(() => setCopied(false), 1500);
        return () => clearTimeout(t);
    }, [copied]);

    const text = useMemo(() => (output ? plainText(output.output) : ""), [output]);

    useLayoutEffect(() => {
        const el = ref.current;
        if (el && pinned.current) el.scrollTop = el.scrollHeight;
    }, [text]);

    return (
        <div className="flex flex-col gap-1 pt-0.5 pr-2 pb-1.5" style={{ paddingLeft: 42 + indent }}>
            <div className="overflow-hidden rounded-md border border-dark-700 bg-dark-900">
                <div className="relative">
                    <pre
                        ref={ref}
                        onScroll={(e) => {
                            const el = e.currentTarget;
                            pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
                        }}
                        className={cn(
                            "max-h-48 overflow-auto px-2.5 py-2",
                            "font-mono text-[10.5px] leading-[1.5] break-all whitespace-pre-wrap",
                            text ? "text-dark-100" : "text-dark-250"
                        )}
                    >
                        {text || (error ? "" : output ? "No output yet." : "Reading…")}
                    </pre>
                    {/* Older lines fade out at the top. */}
                    <span className="pointer-events-none absolute inset-x-0 top-0 h-4 bg-gradient-to-b from-dark-900 to-transparent" />
                </div>
                <div className="flex items-center gap-2 border-t border-dark-700 py-0.5 pr-0.5 pl-2.5 text-[10.5px] text-dark-250">
                    <span className="min-w-0 flex-1 truncate">
                        {output?.truncated
                            ? `Last 8 KB of ${Math.round(output.totalBytes / 1024).toLocaleString("en-US")} KB`
                            : ""}
                    </span>
                    <button
                        type="button"
                        disabled={!text}
                        onClick={() => void navigator.clipboard.writeText(text).then(() => setCopied(true))}
                        className="inline-flex h-5 items-center gap-1 rounded px-1.5 text-dark-200 outline-none transition-colors hover:bg-dark-700 hover:text-dark-50 focus-visible:bg-dark-700 disabled:pointer-events-none disabled:opacity-50"
                    >
                        {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
                        {copied ? "Copied" : "Copy"}
                    </button>
                </div>
            </div>
            {error && <span className="text-[11px] text-danger">{error}</span>}
        </div>
    );
}
