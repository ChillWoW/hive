import { useEffect, useRef, useState } from "react";
import {
    ArchiveIcon,
    ArrowCounterClockwiseIcon,
    DotsThreeIcon,
    PencilSimpleIcon,
    PushPinIcon,
    PushPinSlashIcon,
    TrashIcon
} from "@phosphor-icons/react";
import { activity, chats, useChatsStore } from "@/chats";
import { HarnessIcon } from "@/harnesses";
import { cn } from "@/lib/cn";
import type { Chat } from "@/proto";
import { ContextMenu, Menu, Tooltip } from "@/ui";
import { ChatCard } from "./ChatCard";
import { statusOf } from "./status";
import { StatusMark } from "./StatusMark";
import { useSidebarStore } from "./store";
import { timeAgo, useMinuteClock } from "./time";

export const UNTITLED = "New chat";

/** How long the pointer rests on a row before its card shows (as in zeron). */
export const CARD_DWELL = 550;

/**
 * One chat in the sidebar: status dot, title, time since its last activity
 * and its harness's mark. The "⋯" button (on hover) and a right-click open
 * the same menu: Rename (in place), Pin, Archive, Delete. Resting on it
 * shows its card (`ChatCard`) beside the sidebar; a click or a menu hides it.
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
    const [menuOpen, setMenuOpen] = useState(false);
    const [contextOpen, setContextOpen] = useState(false);

    const status = statusOf(chat, session);
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
        <Tooltip disabled={renaming || menuOpen || contextOpen} disableHoverablePopup>
            <ContextMenu onOpenChange={setContextOpen}>
                <ContextMenu.Trigger
                    // The whole row triggers the card, "⋯" included.
                    render={<Tooltip.Trigger delay={CARD_DWELL} closeOnClick render={<div />} />}
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
                            <StatusMark status={status} />
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
                                    "w-7 shrink-0 text-right text-[11px] text-dark-250 tabular-nums",
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
                        <Menu onOpenChange={setMenuOpen}>
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
            <Tooltip.Content
                side="right"
                align="start"
                sideOffset={10}
                collisionPadding={12}
                className="w-[284px] max-w-none p-3 font-normal"
            >
                <ChatCard chat={chat} session={session} title={title} />
            </Tooltip.Content>
        </Tooltip>
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
                className="min-w-0 flex-1 bg-transparent text-xs text-dark-50 outline-none placeholder:text-dark-250"
            />
        </div>
    );
}
