import { useRef, useState } from "react";
import {
    ArchiveIcon,
    ArrowCounterClockwiseIcon,
    ArrowsLeftRightIcon,
    DotsThreeIcon,
    PencilSimpleIcon,
    PencilSimpleLineIcon,
    PushPinIcon,
    PushPinSlashIcon,
    TrashIcon
} from "@phosphor-icons/react";
import { activity, chats, isBusy, useChatsStore, workDir } from "@/chats";
import { continueIn, handoffBlocked, handoffConfig } from "@/chat/handoff";
import { describeActivity } from "@/transcript";
import { ActivityText } from "./ActivityText";
import { useSetting } from "@/settings/store";
import { useHasDraft } from "@/composer";
import { HarnessIcon, useCatalogs } from "@/harnesses";
import { cn } from "@/lib/cn";
import type { Chat } from "@/proto";
import { ContextMenu, Menu, Tooltip, useInlineRename } from "@/ui";
import { ChatCard } from "./ChatCard";
import { ROW_ACTION, rowClassName, warn } from "./rows";
import { statusOf } from "./status";
import { StatusMark } from "./StatusMark";
import { useSidebarStore } from "./store";
import { timeAgo, useMinuteClock } from "@/lib/time";

export const UNTITLED = "New chat";

/** How long the pointer rests on a row before its card shows. */
export const CARD_DWELL = 300;

/**
 * One chat in the sidebar: status dot, title, time since its last activity
 * and its harness's mark. The "⋯" button (on hover) and a right-click open
 * the same menu: Rename (in place), Continue in (another agent), Pin,
 * Archive, Delete. Resting on it
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
    const drafted = useHasDraft(chat.id) && !active;
    const setRenaming = useSidebarStore((s) => s.setRenaming);
    const now = useMinuteClock();
    // Rename puts the caret in the field; the closing menu mustn't take it back.
    const keepFocus = useRef(false);
    const [menuOpen, setMenuOpen] = useState(false);
    const [contextOpen, setContextOpen] = useState(false);

    const status = statusOf(chat, session);
    const title = chat.title?.trim() || UNTITLED;
    const showActivity = useSetting("chats", "showActivity").value;
    const line = showActivity ? describeActivity(session, workDir(chat)) : null;

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
                                rowClassName(active),
                                // A second line while the agent works.
                                line && "h-auto min-h-7 py-1",
                                "group-has-[[data-popup-open]]/chat:bg-dark-800"
                            )}
                        >
                            <StatusMark status={status} />
                            <span className="flex min-w-0 flex-1 flex-col">
                                <span
                                    className={cn(
                                        "truncate",
                                        !chat.title && "text-dark-200",
                                        status === "unseen" && "font-medium text-dark-50"
                                    )}
                                >
                                    {title}
                                </span>
                                {line && <ActivityText line={line} />}
                            </span>
                            <span
                                className={cn(
                                    "flex w-7 shrink-0 justify-end text-[11px] text-dark-250 tabular-nums",
                                    "group-hover/chat:invisible group-has-[[data-popup-open]]/chat:invisible"
                                )}
                            >
                                {/* An unsent prompt waits in the chat's composer. */}
                                {drafted ? (
                                    <PencilSimpleLineIcon
                                        role="img"
                                        aria-label="Draft"
                                        className="size-3 text-dark-200"
                                    />
                                ) : (
                                    timeAgo(activity(chat), now)
                                )}
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
                                    ROW_ACTION,
                                    // Over the time, which hides on hover.
                                    "right-6 group-hover/chat:opacity-100",
                                    "data-[popup-open]:bg-dark-600 data-[popup-open]:text-dark-50 data-[popup-open]:opacity-100"
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
    const busy = isBusy(useChatsStore((s) => s.sessions[chat.id]?.status));
    // Every other agent turned on; one not installed is offered but can't be picked.
    const targets = useCatalogs().filter((c) => c.id !== chat.config.harness);
    const blocked = handoffBlocked(busy, chat.lastMessageAt != null);
    return (
        <>
            <Menu.Item onClick={onRename}>
                <PencilSimpleIcon className="size-3.5" />
                Rename
            </Menu.Item>
            {targets.length > 0 && (
                <Menu.SubmenuRoot>
                    <Menu.SubmenuTrigger disabled={!!blocked}>
                        <ArrowsLeftRightIcon className="size-3.5" />
                        Continue in
                    </Menu.SubmenuTrigger>
                    <Menu.Content className="w-44 min-w-0">
                        {targets.map((catalog) => (
                            <Menu.Item
                                key={catalog.id}
                                disabled={!catalog.installed}
                                onClick={() =>
                                    void continueIn(chat, handoffConfig(chat, catalog)).catch(warn)
                                }
                            >
                                <HarnessIcon harness={catalog.id} className="size-3.5" />
                                {catalog.label}
                            </Menu.Item>
                        ))}
                    </Menu.Content>
                </Menu.SubmenuRoot>
            )}
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
    const { finish, value, inputProps } = useInlineRename({
        onEnter: () => end(true),
        onEscape: () => end(false),
        onBlur: () => end(true)
    });

    const end = (save: boolean) =>
        finish(() => {
            const next = value();
            // Blank keeps the current title.
            if (save && next && next !== chat.title) {
                chats.rename(chat.id, next).catch(warn);
            }
            onDone();
        });

    return (
        <div className="flex h-7 items-center gap-2 rounded-md bg-dark-800 pr-1.5 pl-2 ring-1 ring-dark-500">
            <span className="w-4 shrink-0" />
            <input
                {...inputProps}
                defaultValue={chat.title ?? ""}
                placeholder={UNTITLED}
                aria-label="Chat title"
                spellCheck={false}
                className="min-w-0 flex-1 bg-transparent text-xs text-dark-50 outline-none placeholder:text-dark-250"
            />
        </div>
    );
}
