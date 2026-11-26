import {
    ArrowUpIcon,
    PauseIcon,
    PaperclipIcon,
    RobotIcon,
    StopIcon,
    TerminalWindowIcon,
    WaveformIcon,
    XIcon
} from "@phosphor-icons/react";
import type { BackgroundTask, QueuedPrompt } from "@/proto";
import { cn } from "@/lib/cn";
import { Tooltip } from "@/ui";

const rowButton = cn(
    "inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted outline-none",
    "transition-colors hover:bg-hover hover:text-text focus-visible:bg-hover"
);

function RowButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
    return (
        <Tooltip>
            <Tooltip.Trigger
                render={
                    <button type="button" aria-label={label} onClick={onClick} className={rowButton}>
                        {children}
                    </button>
                }
            />
            <Tooltip.Content side="top">{label}</Tooltip.Content>
        </Tooltip>
    );
}

/** The tray's frame: a slim card above the composer. */
function Tray({ title, children }: { title: React.ReactNode; children: React.ReactNode }) {
    return (
        <div className="mb-2 overflow-hidden rounded-xl border border-border bg-surface/80 transition-[opacity,translate] duration-200 ease-out starting:translate-y-1 starting:opacity-0">
            <div className="flex items-center gap-1.5 px-3 pt-1.5 text-[11px] font-medium tracking-wide text-muted uppercase">
                {title}
            </div>
            <ul className="flex flex-col p-1">{children}</ul>
        </div>
    );
}

/**
 * Prompts sent while the turn runs, first to go first: each can be sent now
 * (stopping the turn) or dropped. After a stop the queue is held until the
 * next turn the user starts ends; Resume sends its first now.
 */
export function QueuedTray({
    queued,
    held,
    onSendNow,
    onCancel
}: {
    queued: QueuedPrompt[];
    held: boolean;
    onSendNow: (id: string) => void;
    onCancel: (id: string) => void;
}) {
    if (queued.length === 0) return null;
    return (
        <Tray
            title={
                <>
                    {held && <PauseIcon className="size-3" weight="fill" />}
                    <span>{held ? "Queue paused after the stop" : `Queued · ${queued.length}`}</span>
                    {held && (
                        <button
                            type="button"
                            onClick={() => onSendNow(queued[0]!.id)}
                            className="ml-auto rounded-sm px-1.5 py-0.5 text-[11px] text-accent normal-case hover:bg-hover"
                        >
                            Resume
                        </button>
                    )}
                </>
            }
        >
            {queued.map((item, index) => (
                <li key={item.id} className="group/row flex min-h-8 items-center gap-2 rounded-lg px-2 hover:bg-hover/60">
                    <span className="w-4 shrink-0 text-center text-xs text-muted/70 tabular-nums">{index + 1}</span>
                    <span className="min-w-0 flex-1 truncate text-[13px] text-text/90">
                        {item.prompt || <span className="text-muted">Attached files</span>}
                    </span>
                    {(item.attachments?.length ?? 0) > 0 && (
                        <span className="flex shrink-0 items-center gap-0.5 text-xs text-muted">
                            <PaperclipIcon className="size-3" />
                            {item.attachments!.length}
                        </span>
                    )}
                    <RowButton label="Send now" onClick={() => onSendNow(item.id)}>
                        <ArrowUpIcon className="size-3.5" weight="bold" />
                    </RowButton>
                    <RowButton label="Remove" onClick={() => onCancel(item.id)}>
                        <XIcon className="size-3.5" />
                    </RowButton>
                </li>
            ))}
        </Tray>
    );
}

const TASK_ICONS = {
    agent: RobotIcon,
    shell: TerminalWindowIcon,
    monitor: WaveformIcon,
    other: TerminalWindowIcon
} as const;

/** Work the agent left running in the background, each with a stop button. */
export function TasksTray({ tasks, onStop }: { tasks: BackgroundTask[]; onStop: (id: string) => void }) {
    if (tasks.length === 0) return null;
    return (
        <Tray title={`Running in the background · ${tasks.length}`}>
            {tasks.map((task) => {
                const Icon = TASK_ICONS[task.kind];
                return (
                    <li key={task.id} className="flex min-h-8 items-center gap-2 rounded-lg px-2 hover:bg-hover/60">
                        <Icon className="size-3.5 shrink-0 text-muted" />
                        <span className="shimmer min-w-0 flex-1 truncate text-[13px]">
                            {task.description || task.agentType || task.id}
                        </span>
                        {task.agentType && (
                            <span className="shrink-0 text-xs text-muted/80">{task.agentType}</span>
                        )}
                        <RowButton label="Stop" onClick={() => onStop(task.id)}>
                            <StopIcon className="size-3.5" weight="fill" />
                        </RowButton>
                    </li>
                );
            })}
        </Tray>
    );
}
