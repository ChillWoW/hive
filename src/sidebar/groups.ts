import { useMemo } from "react";
import { useChatsStore } from "@/chats";
import { useHiddenFolders, useProjects } from "@/projects";
import type { Chat } from "@/proto";

export type ProjectGroup = { path: string; chats: Chat[] };

export type SidebarGroups = {
    /** In pin order, first pinned first. */
    pinned: Chat[];
    /** Every project in `useProjects` order, then folders that only chats remember. */
    projects: ProjectGroup[];
    archived: Chat[];
};

/**
 * The sidebar's sections. A chat is in at most one: Archived if archived,
 * else Pinned if pinned, else its folder's project (none while that project
 * is deleted). Chats keep the store's
 * order (most recently active first).
 */
export function useSidebarGroups(): SidebarGroups {
    const chats = useChatsStore((s) => s.chats);
    const known = useProjects();
    const hidden = useHiddenFolders();

    return useMemo(() => {
        const pinned: Chat[] = [];
        const archived: Chat[] = [];
        const byPath = new Map<string, Chat[]>(known.map((path) => [path, []]));
        // Folders only chats remember (not a deleted project's), at the bottom.
        const orphans: string[] = [];

        for (const chat of chats) {
            if (chat.archived) archived.push(chat);
            else if (chat.pinnedAt != null) pinned.push(chat);
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
            chats: byPath.get(path) ?? []
        }));
        return { pinned, projects, archived };
    }, [chats, known, hidden]);
}
