import { useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import {
    ArrowBendDownRightIcon,
    ArrowUpIcon,
    DotsSixVerticalIcon,
    PaperclipIcon,
    PencilSimpleIcon,
    PlayIcon,
    XIcon
} from "@phosphor-icons/react";
import { chats, type TranscriptMessage } from "@/chats";
import { composer } from "@/composer";
import { cn } from "@/lib/cn";
import { iconButtonClassName, Tooltip } from "@/ui";

/** Every row is one line tall, so a drag can count rows by distance. */
const ROW = 28;

type Drag = { id: string; from: number; startY: number; dy: number };

function promptText(message: TranscriptMessage) {
    return message.parts
        .flatMap((p) => (p.kind === "text" ? [p.text] : []))
        .join("\n\n");
}

/**
 * Prompts waiting for the running turn to end, tucked behind the composer's
 * top edge: drag (or arrow keys on the handle) to reorder; per row, edit
 * (back into the composer), send now (stopping the running turn) and remove.
 * After the user stops a turn the queue holds until resumed or the next
 * turn ends.
 */
export function QueuedTray({
    chatId,
    messages,
    running
}: {
    chatId: string;
    messages: TranscriptMessage[];
    /** A turn is running; false means the queue is held after a stop. */
    running: boolean;
}) {
    const [drag, setDrag] = useState<Drag | null>(null);
    const last = messages.length - 1;
    const to = drag ? Math.min(last, Math.max(0, drag.from + Math.round(drag.dy / ROW))) : -1;

    const move = (from: number, target: number) => {
        if (from === target) return;
        const ids = messages.map((m) => m.id);
        const [id] = ids.splice(from, 1);
        ids.splice(target, 0, id);
        void chats.reorderQueued(chatId, ids).catch(() => {});
    };

    /** Where row `i` sits while another is dragged. */
    const shift = (i: number) => {
        if (!drag) return 0;
        if (i === drag.from) {
            return Math.min(last - drag.from, Math.max(-drag.from, drag.dy / ROW)) * ROW;
        }
        if (drag.from < to && i > drag.from && i <= to) return -ROW;
        if (drag.from > to && i >= to && i < drag.from) return ROW;
        return 0;
    };

    const edit = async (message: TranscriptMessage) => {
        const withdrawn = await chats.cancelQueued(message.id).catch(() => false);
        if (!withdrawn) return;
        const draft = composer.draft(chatId).trim();
        const text = promptText(message);
        composer.setDraft(chatId, draft && text ? `${draft}\n\n${text}` : draft || text);
        composer.restoreAttachments(chatId, message.attachments ?? []);
        composer.focus();
    };

    return (
        <div
            className={cn(
                "mx-4 rounded-t-2xl border border-b-0 border-dark-700 bg-dark-900 px-1 pt-1 pb-1.5",
                "transition-[opacity,translate] duration-200 ease-out starting:translate-y-2 starting:opacity-0"
            )}
        >
            <div className="flex h-6 items-center gap-1.5 px-2.5 text-xs">
                <span className="font-medium text-dark-200">Queued</span>
                {!running && <span className="text-dark-250">· paused after stop</span>}
                {!running && (
                    <button
                        type="button"
                        onClick={() => void chats.sendNow(messages[0].id).catch(() => {})}
                        className={cn(
                            "ml-auto -mr-1.5 inline-flex h-5 items-center gap-1 rounded-md px-1.5 text-dark-200 outline-none",
                            "transition-colors hover:bg-dark-700 hover:text-dark-50 focus-visible:bg-dark-700"
                        )}
                    >
                        <PlayIcon className="size-3" weight="fill" />
                        Resume
                    </button>
                )}
            </div>
            <ul className="relative flex flex-col">
                {messages.map((m, i) => {
                    const dragged = drag?.id === m.id;
                    const text = promptText(m);
                    return (
                        <li
                            key={m.id}
                            style={{ transform: `translateY(${shift(i)}px)` }}
                            className={cn(
                                "group relative flex h-7 items-center gap-1 rounded-lg pr-1 pl-0.5",
                                // Only while dragging: a drop lands instantly in its new slot.
                                drag && !dragged && "transition-transform duration-150 ease-out",
                                dragged && "z-10 bg-dark-800 shadow-md shadow-black/30"
                            )}
                        >
                            <Handle
                                sortable={messages.length > 1}
                                dragging={dragged}
                                onPointerDown={(e) => {
                                    if (e.button !== 0) return;
                                    e.currentTarget.setPointerCapture(e.pointerId);
                                    setDrag({ id: m.id, from: i, startY: e.clientY, dy: 0 });
                                }}
                                onPointerMove={(e) => {
                                    if (!dragged || !drag) return;
                                    setDrag({ ...drag, dy: e.clientY - drag.startY });
                                }}
                                onPointerUp={() => {
                                    if (!dragged || !drag) return;
                                    move(drag.from, to);
                                    setDrag(null);
                                }}
                                onPointerCancel={() => setDrag(null)}
                                onKeyDown={(e) => {
                                    const target =
                                        e.key === "ArrowUp" ? i - 1 : e.key === "ArrowDown" ? i + 1 : -1;
                                    if (target < 0 || target > last) return;
                                    e.preventDefault();
                                    move(i, target);
                                }}
                            />
                            <span className="min-w-0 flex-1 truncate text-[13px] text-dark-100">
                                {text.replace(/\s+/g, " ")}
                            </span>
                            {(m.attachments?.length ?? 0) > 0 && (
                                <span
                                    className={cn(
                                        "inline-flex shrink-0 items-center gap-0.5 text-xs text-dark-250",
                                        // Files only: the name stands in for the text.
                                        !text.trim() && "-order-1 min-w-0 flex-1 text-dark-100"
                                    )}
                                >
                                    <PaperclipIcon className="size-3 shrink-0" />
                                    <span className="truncate">
                                        {text.trim()
                                            ? m.attachments!.length
                                            : m.attachments!.map((a) => a.name).join(", ")}
                                    </span>
                                </span>
                            )}
                            <div
                                className={cn(
                                    "flex shrink-0 items-center opacity-0 transition-opacity duration-150",
                                    "group-hover:opacity-100 group-focus-within:opacity-100",
                                    drag && "pointer-events-none opacity-0!"
                                )}
                            >
                                <Action label="Edit" onClick={() => void edit(m)}>
                                    <PencilSimpleIcon className="size-3.5" />
                                </Action>
                                <Action
                                    label={running ? "Send now — stops the current turn" : "Send now"}
                                    onClick={() => void chats.sendNow(m.id).catch(() => {})}
                                >
                                    <ArrowUpIcon className="size-3.5" weight="bold" />
                                </Action>
                                <Action
                                    label="Remove"
                                    onClick={() => void chats.cancelQueued(m.id).catch(() => {})}
                                >
                                    <XIcon className="size-3.5" />
                                </Action>
                            </div>
                        </li>
                    );
                })}
            </ul>
        </div>
    );
}

/** The row's arrow, which turns into a drag handle on hover. */
function Handle({
    sortable,
    dragging,
    ...handlers
}: {
    sortable: boolean;
    dragging: boolean;
    onPointerDown: (e: PointerEvent<HTMLButtonElement>) => void;
    onPointerMove: (e: PointerEvent<HTMLButtonElement>) => void;
    onPointerUp: (e: PointerEvent<HTMLButtonElement>) => void;
    onPointerCancel: (e: PointerEvent<HTMLButtonElement>) => void;
    onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => void;
}) {
    const arrow = <ArrowBendDownRightIcon className="size-3.5 text-dark-400" />;
    if (!sortable) {
        return <span className="inline-flex size-6 shrink-0 items-center justify-center">{arrow}</span>;
    }
    return (
        <button
            type="button"
            aria-label="Reorder (drag, or arrow keys)"
            className={cn(
                "relative inline-flex size-6 shrink-0 touch-none items-center justify-center rounded-md outline-none",
                "cursor-grab focus-visible:bg-dark-700",
                dragging && "cursor-grabbing"
            )}
            {...handlers}
        >
            <span
                className={cn(
                    "transition-opacity duration-150 group-hover:opacity-0 group-focus-within:opacity-0",
                    dragging && "opacity-0"
                )}
            >
                {arrow}
            </span>
            <DotsSixVerticalIcon
                weight="bold"
                className={cn(
                    "absolute size-3.5 text-dark-300 opacity-0 transition-opacity duration-150",
                    "group-hover:opacity-100 group-focus-within:opacity-100",
                    dragging && "opacity-100"
                )}
            />
        </button>
    );
}

function Action({
    label,
    onClick,
    children
}: {
    label: string;
    onClick: () => void;
    children: ReactNode;
}) {
    return (
        <Tooltip>
            <Tooltip.Trigger
                render={
                    <button type="button" aria-label={label} onClick={onClick} className={iconButtonClassName}>
                        {children}
                    </button>
                }
            />
            <Tooltip.Content side="top">{label}</Tooltip.Content>
        </Tooltip>
    );
}
