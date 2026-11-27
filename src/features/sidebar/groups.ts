import { useMemo } from "react";
import { useChatsStore } from "@/features/chats";
import { useHiddenFolders, useProjects } from "@/features/projects";
import type { Chat } from "@/proto";
import { LIVE, type LiveStatus } from "./status";
import { isUnread, useSidebarStore } from "./store";

export type ProjectGroup = { path: string; chats: Chat[] };

export type SidebarGroups = {
    /** Every project in `useProjects` order, then folders that only chats remember. */
    projects: ProjectGroup[];
    archived: Chat[];
};

export type Counts = Record<LiveStatus, number>;

export type Statuses = {
    /** Chats that aren't idle, by id. */
    of: Map<string, LiveStatus>;
    /** How many listed chats have each status; archived ones don't count. */
    counts: Counts;
};

/**
 * Every chat's status: asking while its turn waits on the user, working
 * while it runs, unread when it replied since the user last left it
 * (`isUnread`; never the open chat, which is being read), else idle.
 */
export function useStatuses(): Statuses {
    const chats = useChatsStore((s) => s.chats);
    // A string, so session updates that change no status don't recompute.
    const liveKey = useChatsStore((s) =>
        Object.values(s.sessions)
            .filter((x) => x.working || x.asking || x.secrets.length > 0)
            .map((x) => `${x.chatId} ${x.asking || x.secrets.length > 0 ? "asking" : "working"}`)
            .sort()
            .join("\n")
    );
    const openId = useChatsStore((s) => s.activeChatId);
    const seen = useSidebarStore((s) => s.seen);
    const since = useSidebarStore((s) => s.since);
    const hidden = useHiddenFolders();

    return useMemo(() => {
        const live = new Map(
            liveKey
                .split("\n")
                .filter(Boolean)
                .map((line) => line.split(" ") as [string, LiveStatus])
        );
        const of = new Map<string, LiveStatus>();
        const counts: Counts = { asking: 0, working: 0, unread: 0 };
        for (const chat of chats) {
            const status =
                live.get(chat.id) ?? (chat.id !== openId && isUnread(chat, seen, since) ? "unread" : null);
            if (!status) continue;
            of.set(chat.id, status);
            if (!chat.archived && !hidden.has(chat.cwd)) counts[status]++;
        }
        return { of, counts };
    }, [chats, liveKey, openId, seen, since, hidden]);
}

/** The filter in effect: the picked status, while some chat still has it. */
export function activeFilter(filter: LiveStatus | null, counts: Counts): LiveStatus | null {
    return filter && counts[filter] > 0 ? filter : null;
}

/**
 * The sidebar's groups. A chat has one place and keeps it whatever it's
 * doing: Archived if archived, else its folder's project (none while that
 * project is deleted). In a project, pinned chats come first, in pin order,
 * then the rest, most recently active first; a chat an agent started sits
 * right under its parent.
 */
export function useSidebarGroups(): SidebarGroups {
    const chats = useChatsStore((s) => s.chats);
    const known = useProjects();
    const hidden = useHiddenFolders();

    return useMemo(() => {
        const archived: Chat[] = [];
        const byPath = new Map<string, Chat[]>(known.map((path) => [path, []]));
        // Folders only chats remember (not a deleted project's), at the bottom.
        const orphans: string[] = [];

        for (const chat of chats) {
            if (chat.archived) archived.push(chat);
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
        // Fixed by their first chat, so they don't move.
        const firstAt = (path: string) =>
            Math.min(...(byPath.get(path) ?? []).map((c) => c.createdAt));
        orphans.sort((a, b) => firstAt(a) - firstAt(b));

        const projects = [...known, ...orphans].map((path) => ({
            path,
            chats: nest(pinnedFirst(byPath.get(path) ?? []))
        }));
        return { projects, archived: nest(archived) };
    }, [chats, known, hidden]);
}

/** Pinned chats in pin order (first pinned first), then the rest as they were. */
function pinnedFirst(list: Chat[]): Chat[] {
    const pinned = list.filter((c) => c.pinnedAt != null).sort((a, b) => a.pinnedAt! - b.pinnedAt!);
    return pinned.length ? [...pinned, ...list.filter((c) => c.pinnedAt == null)] : list;
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

/** How many of `chats` have each status. */
export function countStatuses(chats: Chat[], statuses: Statuses["of"]): Counts {
    const counts: Counts = { asking: 0, working: 0, unread: 0 };
    for (const chat of chats) {
        const status = statuses.get(chat.id);
        if (status) counts[status]++;
    }
    return counts;
}

/** The statuses some chat has, most urgent first. */
export const present = (counts: Counts) => LIVE.filter((status) => counts[status] > 0);
