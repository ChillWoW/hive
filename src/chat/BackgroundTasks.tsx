import { useMemo, useState, type KeyboardEvent, type ReactNode } from "react";
import {
    CaretRightIcon,
    EyeIcon,
    FlowArrowIcon,
    GearSixIcon,
    RobotIcon,
    StackIcon,
    TerminalWindowIcon,
    type Icon
} from "@phosphor-icons/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { chats, type TranscriptMessage } from "@/chats";
import { cn } from "@/lib/cn";
import { errorMessage } from "@/lib/errors";
import { formatElapsed, useNow } from "@/lib/time";
import type { BackgroundTask, BackgroundTaskKind, HarnessId, ToolCall } from "@/proto";
import {
    AgentMark,
    failureOf,
    findSpawnIn,
    plainText,
    progressLine,
    RoundAvatar,
    servedUrl,
    useTaskOutput,
    type SpawnPart
} from "@/transcript";
import { DotMatrixSpinner } from "@/ui";
import { ChipPopover } from "@/ui/ChipPopover";

/**
 * Each kind: its glyph, what one and many are called, its section's title
 * (the list's sections go in this order) and the row's second line.
 */
const KINDS: Record<BackgroundTaskKind, { icon: Icon; noun: [string, string]; title: string; detail?: string }> = {
    agent: { icon: RobotIcon, noun: ["agent", "agents"], title: "Agents" },
    shell: { icon: TerminalWindowIcon, noun: ["shell", "shells"], title: "Shells", detail: "Shell" },
    monitor: { icon: EyeIcon, noun: ["monitor", "monitors"], title: "Monitors", detail: "Monitor" },
    workflow: { icon: FlowArrowIcon, noun: ["workflow", "workflows"], title: "Workflows", detail: "Workflow" },
    other: { icon: GearSixIcon, noun: ["task", "tasks"], title: "Other" }
};

const ORDER = Object.keys(KINDS) as BackgroundTaskKind[];

/** "2 shells", "1 agent", or "3 tasks" for a mix, with the kind's icon. */
function summary(tasks: BackgroundTask[]): { label: string; icon: Icon } {
    const mixed = new Set(tasks.map((t) => t.kind)).size > 1;
    const { noun, icon } = KINDS[mixed ? "other" : tasks[0].kind];
    // A mix is a stack of things, not the gear an unknown task gets.
    return { label: `${tasks.length} ${tasks.length === 1 ? noun[0] : noun[1]}`, icon: mixed ? StackIcon : icon };
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
    const [open, setOpen] = useState(false);
    // Tool calls by id, for the command a shell runs.
    const calls = useMemo(() => {
        const map = new Map<string, ToolCall>();
        for (const m of messages)
            for (const p of m.parts) if (p.kind === "tool") map.set(p.id, p.call);
        return map;
    }, [messages]);

    if (!tasks?.length) return null;

    const { label, icon: KindIcon } = summary(tasks);
    return (
        <ChipPopover
            open={open}
            onOpenChange={setOpen}
            label="Background tasks"
            triggerLabel={`Background: ${label}`}
            triggerClassName={cn(
                "px-2 text-info",
                "hover:bg-info/12 hover:text-info data-[popup-open]:bg-info/12 data-[popup-open]:text-info"
            )}
            trigger={
                <>
                    <KindIcon className="size-3.5" />
                    <span className="tabular-nums">{label}</span>
                </>
            }
            className="w-[22.5rem]"
        >
            <TaskList
                chatId={chatId}
                harness={harness}
                tasks={tasks}
                calls={calls}
                messages={messages}
                onOpenAgent={(id) => {
                    setOpen(false);
                    chats.openSubagent(chatId, id);
                }}
            />
        </ChipPopover>
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
            setErrors((errs) => ({ ...errs, [taskId]: errorMessage(e) }));
        });
    };
    const live = tasks.filter((t) => !stopping.has(t.id));
    const sections = ORDER.map((kind) => ({
        kind,
        title: KINDS[kind].title,
        tasks: tasks.filter((t) => t.kind === kind)
    })).filter((s) => s.tasks.length);

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
                            {nest(section.tasks).map(({ task, depth }) =>
                                task.kind === "shell" || task.kind === "monitor" ? (
                                    <ShellTaskRow
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
                                ) : (
                                    <TaskRow
                                        key={task.id}
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
                                )
                            )}
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
    return { text: task.description || KINDS[task.kind].noun[0], mono: false };
}

/** The row's second line for anything but an agent. */
function detailOf(task: BackgroundTask, call: ToolCall | undefined): string | undefined {
    // A shell titled by its command keeps its description under it.
    if (call?.kind === "exec") return task.description && task.description !== call.command ? task.description : undefined;
    return KINDS[task.kind].detail;
}

/** The tool calls a subagent has made so far. */
function toolCount(spawn: SpawnPart | undefined): number {
    return spawn?.thread?.filter((p) => p.kind === "tool").length ?? 0;
}

/** An agent, workflow or other task; shells and monitors are `ShellTaskRow`s. */
function TaskRow({
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
    const agent = task.kind === "agent";
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

    const action = openable ? { label: `Open ${title}`, run: () => onOpenAgent(spawn.id) } : null;

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
                        {stopping
                            ? "Stopping…"
                            : task.startedAt != null && formatElapsed(now - task.startedAt, { pad: true })}
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
                    </span>
                </span>
            </div>
            {error && (
                <div className="pb-1 text-[11px] text-danger" style={{ paddingLeft: 42 + indent }}>
                    {error}
                </div>
            )}
        </div>
    );
}

/** How often a listed shell's row reads its output for its latest line. */
const SHELL_ROW_POLL_MS = 2000;

/**
 * A shell or monitor: a dot matrix while it runs (a red dot once its output
 * says it failed), its description (else its command) with the address it
 * serves (opens in the browser) or how its latest run went, and under it the
 * newest line of its output, live; then how long it has run, Stop. It
 * doesn't open: the transcript's row for it has the output.
 */
function ShellTaskRow({
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
    const { output } = useTaskOutput(chatId, task.id, SHELL_ROW_POLL_MS);
    const text = useMemo(() => (output ? plainText(output.output) : ""), [output]);
    const url = servedUrl(text);
    const failure = failureOf(text);
    const lastLine = text.split("\n").findLast((l) => l.trim())?.trim();

    const command = call?.kind === "exec" ? call.command : undefined;
    const title = task.description || command || KINDS[task.kind].noun[0];
    // Until it has printed something, the second line is what it runs.
    const line = lastLine ?? (task.description ? command : undefined);
    const indent = depth * 16;

    return (
        <div className="flex flex-col">
            <div
                className={cn(
                    "group/task relative flex items-center gap-2.5 rounded-md py-1.5 pr-1 transition-colors duration-100",
                    "has-[>button:focus-visible]:bg-white/[0.05]",
                    stopping && "opacity-60"
                )}
                style={{ paddingLeft: 8 + indent }}
            >
                {/* Only a focus stop for ↑↓ and Backspace; the address and Stop sit above it. */}
                <button
                    type="button"
                    data-task-row={task.id}
                    aria-label={title}
                    className="absolute inset-0 cursor-default rounded-md outline-none"
                />
                <TaskAvatar task={task} failed={!!failure} />
                <span className="pointer-events-none flex min-w-0 flex-1 flex-col">
                    <span className="flex min-w-0 items-center gap-1.5">
                        <span
                            className={cn(
                                "truncate text-xs text-dark-50",
                                task.description ? "font-medium" : "font-mono text-[11px]"
                            )}
                        >
                            {title}
                        </span>
                        {url && (
                            <button
                                type="button"
                                tabIndex={-1}
                                aria-label={`Open ${url.url}`}
                                onClick={() => void openUrl(url.url).catch(() => {})}
                                className="pointer-events-auto relative z-10 inline-flex h-4 shrink-0 items-center rounded bg-info/12 px-1.5 font-mono text-[10.5px] text-info outline-none transition-colors hover:bg-info/20"
                            >
                                :{url.port}
                            </button>
                        )}
                        {failure && (
                            <span className="inline-flex h-4 shrink-0 items-center rounded bg-danger/12 px-1.5 text-[10.5px] text-danger">
                                {failure}
                            </span>
                        )}
                    </span>
                    {line && (
                        <span
                            className={cn(
                                "truncate font-mono text-[11px] leading-relaxed",
                                failure ? "text-danger" : "text-dark-200"
                            )}
                        >
                            {line}
                        </span>
                    )}
                </span>
                <span className="pointer-events-none relative z-10 flex shrink-0 items-center gap-0.5">
                    <span className="px-1 text-[11px] text-dark-200 tabular-nums">
                        {stopping
                            ? "Stopping…"
                            : task.startedAt != null && formatElapsed(now - task.startedAt, { pad: true })}
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
                    {/* The agents' caret column, so times and Stop line up. */}
                    <span className="w-3.5" />
                </span>
            </div>
            {error && (
                <div className="pb-1 text-[11px] text-danger" style={{ paddingLeft: 42 + indent }}>
                    {error}
                </div>
            )}
        </div>
    );
}

/**
 * A round avatar as the transcript's subagents have (the harness mark for an
 * agent, its kind's glyph otherwise), a live dot matrix on its corner, or a
 * red dot once it `failed`.
 */
function TaskAvatar({ task, harness, failed = false }: { task: BackgroundTask; harness?: HarnessId; failed?: boolean }) {
    const Glyph = KINDS[task.kind].icon;
    return (
        <RoundAvatar className="pointer-events-none">
            {task.kind === "agent" && harness ? (
                <AgentMark harness={harness} />
            ) : (
                <Glyph className="size-3.5 text-dark-200" />
            )}
            <span className="absolute -right-1 -bottom-1 grid size-3 place-items-center rounded-full bg-dark-850 text-info">
                {failed ? (
                    <span className="size-1.5 rounded-full bg-danger" />
                ) : (
                    <DotMatrixSpinner interval={400} label="Running" className="size-[7px] gap-[0.5px]" />
                )}
            </span>
        </RoundAvatar>
    );
}
