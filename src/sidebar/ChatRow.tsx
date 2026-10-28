import { useEffect, useRef } from "react";
import {
    ArchiveIcon,
    ArrowCounterClockwiseIcon,
    DotsThreeIcon,
    PencilSimpleIcon,
    PushPinIcon,
    PushPinSlashIcon,
    TrashIcon
} from "@phosphor-icons/react";
import { activity, chats, isUnseen, useChatsStore } from "@/chats";
import { HarnessIcon } from "@/harnesses";
import { cn } from "@/lib/cn";
import type { Chat, Session } from "@/proto";
import { ContextMenu, DOT_MATRIX_FULL, DotMatrixSpinner, Menu } from "@/ui";
import { useSidebarStore } from "./store";
import { timeAgo, useMinuteClock } from "./time";

export const UNTITLED = "New chat";

type Status = "working" | "input" | "error" | "unseen" | "idle";

function statusOf(chat: Chat, session: Session | undefined): Status {
    switch (session?.status) {
        case "working":
            return "working";
        case "awaitingInput":
            return "input";
        case "errored":
            return "error";
    }
    return isUnseen(chat) ? "unseen" : "idle";
}

const STATUS: Record<Status, { label: string; className: string }> = {
    // Dot matrices, as the transcript's working line: cycling and neutral
    // while working, every dot lit and pulsing in the warning tone while
    // waiting. Their dots take the text colour.
    working: { label: "Working", className: "text-dark-100" },
    input: { label: "Waiting for you", className: "animate-pulse text-warning" },
    error: { label: "Errored", className: "bg-danger" },
    // Finished while you were elsewhere: ready for you.
    unseen: { label: "New activity", className: "bg-success" },
    idle: { label: "", className: "bg-dark-500" }
};

/**
 * One chat in the sidebar: status dot, title, time since its last activity
 * and its harness's mark. The "⋯" button (on hover) and a right-click open
 * the same menu: Rename (in place), Pin, Archive, Delete.
 */
export function ChatRow({
    chat,
    onDelete
}: {
    chat: Chat;
    onDelete: (chat: Chat) => void;
}) {
    const active = useChatsStore((s) => s.activeChatId === chat.id);
    const session = useChatsStore((s) => s.sessions[chat.id]);
    const renaming = useSidebarStore((s) => s.renaming === chat.id);
    const setRenaming = useSidebarStore((s) => s.setRenaming);
    const now = useMinuteClock();
    // Rename puts the caret in the field; the closing menu mustn't take it back.
    const keepFocus = useRef(false);

    const status = statusOf(chat, session);
    const { label, className } = STATUS[status];
    const title = chat.title?.trim() || UNTITLED;

    const startRename = () => {
        keepFocus.current = true;
        setRenaming(chat.id);
    };
    const finalFocus = () => {
        const keep = keepFocus.current;
        keepFocus.current = false;
        return !keep;
    };

    const items = (
        <ChatMenuItems
            chat={chat}
            onRename={startRename}
            onDelete={() => onDelete(chat)}
        />
    );

    return (
        <ContextMenu>
            <ContextMenu.Trigger
                render={<div />}
                className="group/chat relative"
            >
                {renaming ? (
                    <RenameField chat={chat} onDone={() => setRenaming(null)} />
                ) : (
                    <button
                        type="button"
                        onClick={() => chats.select(chat.id)}
                        aria-current={active ? "page" : undefined}
                        className={cn(
                            "flex h-7 w-full items-center gap-2 rounded-md pr-1.5 pl-2 text-left text-xs outline-none",
                            "transition-colors duration-100",
                            "focus-visible:ring-1 focus-visible:ring-dark-400",
                            active
                                ? "bg-dark-700 text-dark-50"
                                : "text-dark-100 hover:bg-dark-800 hover:text-dark-50",
                            "group-has-[[data-popup-open]]/chat:bg-dark-800"
                        )}
                    >
                        <span className="flex w-4 shrink-0 justify-center">
                            {status === "working" || status === "input" ? (
                                <DotMatrixSpinner
                                    label={label}
                                    pattern={status === "input" ? DOT_MATRIX_FULL : undefined}
                                    className={cn("size-2.5", className)}
                                />
                            ) : (
                                <span
                                    role={label ? "img" : undefined}
                                    aria-label={label || undefined}
                                    className={cn("size-1.5 rounded-full", className)}
                                />
                            )}
                        </span>
                        <span
                            className={cn(
                                "min-w-0 flex-1 truncate",
                                !chat.title && "text-dark-200",
                                status === "unseen" && "font-medium text-dark-50"
                            )}
                        >
                            {title}
                        </span>
                        <span
                            className={cn(
                                "w-7 shrink-0 text-right text-[11px] text-dark-300 tabular-nums",
                                "group-hover/chat:invisible group-has-[[data-popup-open]]/chat:invisible"
                            )}
                        >
                            {timeAgo(activity(chat), now)}
                        </span>
                        <HarnessIcon
                            harness={chat.config.harness}
                            className="size-3 shrink-0 opacity-70"
                        />
                    </button>
                )}

                {!renaming && (
                    <Menu>
                        <Menu.Trigger
                            aria-label={`Options for ${title}`}
                            className={cn(
                                // Over the time, which hides on hover.
                                "absolute top-1/2 right-6 inline-flex size-5 -translate-y-1/2 items-center justify-center",
                                "rounded-sm text-dark-200 outline-none",
                                "transition-[color,background-color,opacity] duration-100",
                                "hover:bg-dark-600 hover:text-dark-50 focus-visible:opacity-100",
                                "data-[popup-open]:bg-dark-600 data-[popup-open]:text-dark-50",
                                "opacity-0 group-hover/chat:opacity-100 data-[popup-open]:opacity-100"
                            )}
                        >
                            <DotsThreeIcon className="size-3.5" weight="bold" />
                        </Menu.Trigger>
                        <Menu.Content
                            side="right"
                            align="start"
                            sideOffset={8}
                            finalFocus={finalFocus}
                            className="w-40 min-w-0"
                        >
                            {items}
                        </Menu.Content>
                    </Menu>
                )}
            </ContextMenu.Trigger>
            <ContextMenu.Content finalFocus={finalFocus} className="w-40 min-w-0">
                {items}
            </ContextMenu.Content>
        </ContextMenu>
    );
}

function ChatMenuItems({
    chat,
    onRename,
    onDelete
}: {
    chat: Chat;
    onRename: () => void;
    onDelete: () => void;
}) {
    const pinned = chat.pinnedAt != null;
    const warn = (error: unknown) => console.warn("[sidebar]", error);
    return (
        <>
            <Menu.Item onClick={onRename}>
                <PencilSimpleIcon className="size-3.5" />
                Rename
            </Menu.Item>
            {!chat.archived && (
                <Menu.Item onClick={() => chats.setPinned(chat.id, !pinned).catch(warn)}>
                    {pinned ? (
                        <PushPinSlashIcon className="size-3.5" />
                    ) : (
                        <PushPinIcon className="size-3.5" />
                    )}
                    {pinned ? "Unpin" : "Pin"}
                </Menu.Item>
            )}
            <Menu.Item
                onClick={() => chats.setArchived(chat.id, !chat.archived).catch(warn)}
            >
                {chat.archived ? (
                    <ArrowCounterClockwiseIcon className="size-3.5" />
                ) : (
                    <ArchiveIcon className="size-3.5" />
                )}
                {chat.archived ? "Unarchive" : "Archive"}
            </Menu.Item>
            <Menu.Separator />
            <Menu.Item variant="danger" onClick={onDelete}>
                <TrashIcon className="size-3.5" />
                Delete…
            </Menu.Item>
        </>
    );
}

/** The title in place, editable: Enter or leaving saves, Escape cancels. */
function RenameField({ chat, onDone }: { chat: Chat; onDone: () => void }) {
    const input = useRef<HTMLInputElement>(null);
    const done = useRef(false);

    useEffect(() => {
        // After the menu's own focus handling settles.
        const frame = requestAnimationFrame(() => {
            input.current?.focus();
            input.current?.select();
        });
        return () => cancelAnimationFrame(frame);
    }, []);

    const finish = (save: boolean) => {
        if (done.current) return;
        done.current = true;
        const next = input.current?.value.trim() ?? "";
        // Blank keeps the current title.
        if (save && next && next !== chat.title) {
            chats.rename(chat.id, next).catch((e) => console.warn("[sidebar]", e));
        }
        onDone();
    };

    return (
        <div className="flex h-7 items-center gap-2 rounded-md bg-dark-800 pr-1.5 pl-2 ring-1 ring-dark-500">
            <span className="w-4 shrink-0" />
            <input
                ref={input}
                defaultValue={chat.title ?? ""}
                placeholder={UNTITLED}
                aria-label="Chat title"
                spellCheck={false}
                onKeyDown={(event) => {
                    if (event.key === "Enter") finish(true);
                    else if (event.key === "Escape") finish(false);
                }}
                onBlur={() => finish(true)}
                className="min-w-0 flex-1 bg-transparent text-xs text-dark-50 outline-none placeholder:text-dark-300"
            />
        </div>
    );
}
