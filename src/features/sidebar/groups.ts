import { useMemo } from "react";
import { useChatsStore } from "@/features/chats";
import { useHiddenFolders, useProjects } from "@/features/projects";
import type { Chat } from "@/proto";
import { isUnread, useSidebarStore } from "./store";

export type ProjectGroup = {
    path: string;
    chats: Chat[];
    /** How many of its chats show in Active instead. */
    active: number;
};

export type SidebarGroups = {
    /** Chats whose turn is running or that have unseen replies, from any project. */
    active: Chat[];
    /** In pin order, first pinned first. */
    pinned: Chat[];
    /** Every project in `useProjects` order, then folders that only chats remember. */
    projects: ProjectGroup[];
    archived: Chat[];
};

/**
 * The sidebar's sections. A chat is in at most one: Archived if archived,
 * else Active while its turn runs or it's unread (`isUnread`), or another chat
 * of its thread (its parent, a chat its agent started) is, else Pinned if
 * pinned, else its folder's project (none while that project is deleted).
 * Chats keep the store's order (most recently active first).
 *
 * The open chat counts as unread until the user leaves it, so a chat that
 * finishes while they read it stays put instead of jumping out of Active.
 */
export function useSidebarGroups(): SidebarGroups {
    const chats = useChatsStore((s) => s.chats);
    // A string, so session updates that don't start or end a turn don't regroup.
    const workingKey = useChatsStore((s) =>
        Object.values(s.sessions)
            .filter((session) => session.working)
            .map((session) => session.chatId)
            .sort()
            .join("\n")
    );
    const seen = useSidebarStore((s) => s.seen);
    const known = useProjects();
    const hidden = useHiddenFolders();

    return useMemo(() => {
        const working = new Set(workingKey.split("\n"));
        const active: Chat[] = [];
        const pinned: Chat[] = [];
        const archived: Chat[] = [];
        const byPath = new Map<string, Chat[]>(known.map((path) => [path, []]));
        const activeIn = new Map<string, number>();
        // Folders only chats remember (not a deleted project's), at the bottom.
        const orphans: string[] = [];

        // A thread: a chat and the chats its agent started. One of them
        // active brings the whole thread to Active.
        const ids = new Set(chats.map((c) => c.id));
        const threadOf = (chat: Chat) =>
            chat.parentChatId != null && ids.has(chat.parentChatId) ? chat.parentChatId : chat.id;
        const activeThreads = new Set(
            chats
                .filter((c) => !c.archived && (working.has(c.id) || isUnread(c, seen)))
                .map(threadOf)
        );

        for (const chat of chats) {
            if (chat.archived) archived.push(chat);
            else if (activeThreads.has(threadOf(chat))) {
                active.push(chat);
                activeIn.set(chat.cwd, (activeIn.get(chat.cwd) ?? 0) + 1);
            } else if (chat.pinnedAt != null) pinned.push(chat);
            else if (!hidden.has(chat.cwd)) {
                let list = byPath.get(chat.cwd);
                if (!list) {
                    list = [];
                    byPath.set(chat.cwd, list);
                    orphans.push(chat.cwd);
                }
                list.push(chat);
            }
        }
        pinned.sort((a, b) => (a.pinnedAt ?? 0) - (b.pinnedAt ?? 0));
        // Fixed by their first chat, so they don't move either.
        const firstAt = (path: string) =>
            Math.min(...(byPath.get(path) ?? []).map((c) => c.createdAt));
        orphans.sort((a, b) => firstAt(a) - firstAt(b));

        const projects = [...known, ...orphans].map((path) => ({
            path,
            chats: nest(byPath.get(path) ?? []),
            active: activeIn.get(path) ?? 0
        }));
        return { active: nest(active), pinned: nest(pinned), projects, archived: nest(archived) };
    }, [chats, known, hidden, workingKey, seen]);
}

/**
 * `list` with the chats an agent started (`parentChatId`) right after their
 * parent, when it's in the same list; the rest keep their order.
 */
function nest(list: Chat[]): Chat[] {
    const ids = new Set(list.map((c) => c.id));
    const nested = (chat: Chat) => chat.parentChatId != null && ids.has(chat.parentChatId);
    const children = new Map<string, Chat[]>();
    for (const chat of list) {
        if (!nested(chat)) continue;
        const parentId = chat.parentChatId!;
        children.set(parentId, [...(children.get(parentId) ?? []), chat]);
    }
    if (!children.size) return list;
    return list.flatMap((chat) => (nested(chat) ? [] : [chat, ...(children.get(chat.id) ?? [])]));
}

/** Whether `chat` shows nested under its parent in `list` (`nest`). */
export function isNested(chat: Chat, list: Chat[]): boolean {
    return chat.parentChatId != null && list.some((c) => c.id === chat.parentChatId);
}
