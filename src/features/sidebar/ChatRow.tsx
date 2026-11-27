import { useRef, useState } from "react";
import {
    ArchiveIcon,
    ArrowCounterClockwiseIcon,
    ChatsIcon,
    DotsThreeIcon,
    PencilSimpleIcon,
    PushPinIcon,
    PushPinSlashIcon,
    TrashIcon
} from "@phosphor-icons/react";
import { activity, chats, useChatsStore, useWorking } from "@/features/chats";
import { handOff, handoffBlocked } from "@/features/chat/handoff";
import { HarnessMark } from "@/features/models";
import { cn } from "@/lib/cn";
import { timeAgo, useMinuteClock } from "@/lib/time";
import type { Chat } from "@/proto";
import { ContextMenu, Menu, Tooltip, useInlineRename } from "@/ui";
import { ChatCard } from "./ChatCard";
import { ROW_ACTION, rowClassName, warn } from "./rows";
import { STATUS, type ChatStatus } from "./status";
import { useSidebarStore } from "./store";

export const UNTITLED = "New chat";

/** How long the pointer rests on a row before its card shows. */
export const CARD_DWELL = 300;

/**
 * One chat in the sidebar: its provider's mark, its title (a pin after it
 * when pinned), then "Needs you" while it waits on the user, else the time
 * since its last activity, with a dot while it has unread replies. The title
 * shimmers while it works. Idle chats are dimmed, so the others stand out.
 * The "⋯" button (on hover, over the status) and a right-click open the
 * same menu: Rename (in place), Pin, Archive, Delete. Resting on it shows
 * its card (`ChatCard`) beside the sidebar; a click or a menu hides it.
 * `nested` indents a chat an agent started under its parent's row.
 */
export function ChatRow({
    chat,
    status,
    onDelete,
    nested = false
}: {
    chat: Chat;
    status: ChatStatus;
    onDelete: (chat: Chat) => void;
    nested?: boolean;
}) {
    const active = useChatsStore((s) => s.activeChatId === chat.id);
    const renaming = useSidebarStore((s) => s.renaming === chat.id);
    const setRenaming = useSidebarStore((s) => s.setRenaming);
    // Rename puts the caret in the field; the closing menu mustn't take it back.
    const keepFocus = useRef(false);
    const [menuOpen, setMenuOpen] = useState(false);
    const [contextOpen, setContextOpen] = useState(false);

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

    const items = <ChatMenuItems chat={chat} onRename={startRename} onDelete={() => onDelete(chat)} />;

    return (
        <Tooltip disabled={renaming || menuOpen || contextOpen} disableHoverablePopup>
            <ContextMenu onOpenChange={setContextOpen}>
                <ContextMenu.Trigger
                    // The whole row triggers the card, "⋯" included.
                    render={<Tooltip.Trigger delay={CARD_DWELL} closeOnClick render={<div />} />}
                    className="group/chat relative"
                >
                    {renaming ? (
                        <RenameField chat={chat} nested={nested} onDone={() => setRenaming(null)} />
                    ) : (
                        <button
                            type="button"
                            onClick={() => chats.select(chat.id)}
                            aria-current={active ? "page" : undefined}
                            className={cn(
                                rowClassName(active),
                                // Idle chats step back; the open one and those doing something don't.
                                !active && (status === "idle" ? "text-text/70" : "text-text"),
                                nested && "pl-6",
                                "group-has-[[data-popup-open]]/chat:bg-raised"
                            )}
                        >
                            <span className="flex w-4 shrink-0 justify-center">
                                <HarnessMark harness={chat.config.harness} className="size-3 shrink-0" />
                            </span>
                            <span className="flex min-w-0 flex-1 items-center gap-1.5">
                                <span
                                    className={cn(
                                        "min-w-0 truncate",
                                        !chat.title && "text-muted",
                                        status === "unread" && "font-medium",
                                        // Light sweeps across a dimmed title while it works.
                                        status === "working" && "shimmer text-muted"
                                    )}
                                >
                                    {title}
                                </span>
                                {chat.pinnedAt != null && (
                                    <PushPinIcon
                                        weight="fill"
                                        role="img"
                                        aria-label="Pinned"
                                        className="size-2.5 shrink-0 text-muted/75"
                                    />
                                )}
                            </span>
                            <span
                                className={cn(
                                    "flex min-w-7 shrink-0 items-center justify-end gap-1.5 text-[11px]",
                                    "group-hover/chat:invisible group-has-[[data-popup-open]]/chat:invisible"
                                )}
                            >
                                <RowStatus chat={chat} status={status} />
                            </span>
                        </button>
                    )}

                    {!renaming && (
                        <Menu onOpenChange={setMenuOpen}>
                            <Menu.Trigger
                                aria-label={`Options for ${title}`}
                                className={cn(
                                    ROW_ACTION,
                                    // Over the status, which hides on hover.
                                    "right-1.5 group-hover/chat:opacity-100",
                                    "data-[popup-open]:bg-border data-[popup-open]:text-text data-[popup-open]:opacity-100"
                                )}
                            >
                                <DotsThreeIcon className="size-3.5" weight="bold" />
                            </Menu.Trigger>
                            <Menu.Content
                                side="right"
                                align="start"
                                sideOffset={8}
                                finalFocus={finalFocus}
                                className="w-48 min-w-0"
                            >
                                {items}
                            </Menu.Content>
                        </Menu>
                    )}
                </ContextMenu.Trigger>
                <ContextMenu.Content finalFocus={finalFocus} className="w-48 min-w-0">
                    {items}
                </ContextMenu.Content>
            </ContextMenu>
            <Tooltip.Content
                side="right"
                sideOffset={10}
                collisionPadding={12}
                className="w-[284px] max-w-none p-3 font-normal"
            >
                <ChatCard
                    chat={chat}
                    title={title}
                    working={status === "working"}
                    asking={status === "asking"}
                />
            </Tooltip.Content>
        </Tooltip>
    );
}

/** A row's right end: what the chat is doing, else when it was last active. */
function RowStatus({ chat, status }: { chat: Chat; status: ChatStatus }) {
    const now = useMinuteClock();
    if (status === "asking") {
        return (
            <>
                <span className={cn("size-1.5 rounded-full", STATUS.asking.className)} />
                <span className="font-medium text-warning">{STATUS.asking.label}</span>
            </>
        );
    }
    return (
        <>
            {status === "unread" && (
                <span
                    role="img"
                    aria-label={STATUS.unread.label}
                    className={cn("size-1.5 rounded-full", STATUS.unread.className)}
                />
            )}
            <span className={cn("tabular-nums", status === "unread" ? "text-text/85" : "text-muted/75")}>
                {timeAgo(activity(chat), now)}
            </span>
        </>
    );
}

/** A chat's menu: Rename, Pin, Archive, Delete. The sidebar's rows and the chat's header share it. */
export function ChatMenuItems({
    chat,
    onRename,
    onDelete
}: {
    chat: Chat;
    onRename: () => void;
    onDelete: () => void;
}) {
    const pinned = chat.pinnedAt != null;
    // A new chat carries this one on, with a summary of it.
    const working = useWorking(chat.id);
    const blocked = handoffBlocked(working, chat.lastMessageAt != null);
    return (
        <>
            <Menu.Item onClick={onRename}>
                <PencilSimpleIcon />
                Rename
            </Menu.Item>
            <Menu.Item disabled={!!blocked} onClick={() => void handOff(chat, chat.config, "newChat")}>
                <ChatsIcon />
                Continue in new chat
            </Menu.Item>
            {!chat.archived && (
                <Menu.Item onClick={() => chats.setPinned(chat.id, !pinned).catch(warn)}>
                    {pinned ? <PushPinSlashIcon /> : <PushPinIcon />}
                    {pinned ? "Unpin" : "Pin"}
                </Menu.Item>
            )}
            <Menu.Item onClick={() => chats.setArchived(chat.id, !chat.archived).catch(warn)}>
                {chat.archived ? (
                    <ArrowCounterClockwiseIcon />
                ) : (
                    <ArchiveIcon />
                )}
                {chat.archived ? "Unarchive" : "Archive"}
            </Menu.Item>
            <Menu.Separator />
            <Menu.Item variant="destructive" onClick={onDelete}>
                <TrashIcon />
                Delete…
            </Menu.Item>
        </>
    );
}

/** The title in place, editable: Enter or leaving saves, Escape cancels. */
function RenameField({ chat, nested, onDone }: { chat: Chat; nested: boolean; onDone: () => void }) {
    const { finish, value, inputProps } = useInlineRename({
        onEnter: () => end(true),
        onEscape: () => end(false),
        onBlur: () => end(true)
    });

    const end = (save: boolean) =>
        finish(() => {
            const next = value();
            // Blank keeps the current title.
            if (save && next && next !== chat.title) chats.rename(chat.id, next).catch(warn);
            onDone();
        });

    return (
        <div
            className={cn(
                "flex h-7 items-center gap-2 rounded-md bg-raised pr-1.5 pl-2 ring-1 ring-border",
                nested && "pl-6"
            )}
        >
            <span className="flex w-4 shrink-0 justify-center">
                <HarnessMark harness={chat.config.harness} className="size-3 shrink-0" />
            </span>
            <input
                {...inputProps}
                defaultValue={chat.title ?? ""}
                placeholder={UNTITLED}
                aria-label="Chat title"
                spellCheck={false}
                className="min-w-0 flex-1 bg-transparent text-xs text-text outline-none placeholder:text-muted/75"
            />
        </div>
    );
}
