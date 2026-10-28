import { useMemo } from "react";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { useChatsStore } from "@/chats";

/** A folder the user works in. Chats run in one; a project can have none yet. */
export type Project = {
    path: string;
    /** Epoch millis of when it was first picked; decides its place in lists. */
    addedAt: number;
};

type ProjectsState = {
    /** Every project picked on this device, in the order they were added. */
    projects: Project[];
    /**
     * Deleted projects. A folder with chats would otherwise come back through
     * them (`useProjects`); adding it again brings it back.
     */
    removed: string[];
    /** Adds `path` at the end; a project already listed stays where it is. */
    add: (path: string) => void;
    /** Takes `path` off the list. Its chats stay. */
    remove: (path: string) => void;
};

/**
 * The projects picked on this device, persisted to localStorage so a folder
 * chosen in the new-chat view stays listed before any chat runs in it.
 * Folders that only have chats are listed too (`useProjects`).
 */
export const useProjectsStore = create<ProjectsState>()(
    persist(
        (set) => ({
            projects: [],
            removed: [],
            add: (path) =>
                set((s) => ({
                    projects: s.projects.some((p) => p.path === path)
                        ? s.projects
                        : [...s.projects, { path, addedAt: Date.now() }],
                    removed: s.removed.filter((r) => r !== path)
                })),
            remove: (path) =>
                set((s) => ({
                    projects: s.projects.filter((p) => p.path !== path),
                    removed: s.removed.includes(path) ? s.removed : [...s.removed, path]
                }))
        }),
        {
            name: "hive.projects",
            version: 2,
            storage: createJSONStorage(() => localStorage),
            partialize: (s) => ({ projects: s.projects, removed: s.removed }),
            // v1 kept `lastUsedAt` instead.
            migrate: (saved) => {
                const projects = (saved as { projects?: unknown[] } | undefined)?.projects;
                return {
                    removed: [],
                    projects: (Array.isArray(projects) ? projects : []).map((p) => {
                        const old = p as { path: string; addedAt?: number; lastUsedAt?: number };
                        return { path: old.path, addedAt: old.addedAt ?? old.lastUsedAt ?? 0 };
                    })
                };
            }
        }
    )
);

/**
 * Every project path: the saved ones and every chat's folder, once each.
 * The order is fixed by when each was first seen (picked, or its first chat
 * created), so projects never move around; new ones land at the bottom.
 */
export function useProjects(): string[] {
    const saved = useProjectsStore((s) => s.projects);
    const removed = useProjectsStore((s) => s.removed);
    const chats = useChatsStore((s) => s.chats);
    return useMemo(() => {
        const first = new Map<string, number>();
        const see = (path: string, at: number) =>
            first.set(path, Math.min(first.get(path) ?? Infinity, at));
        for (const project of saved) see(project.path, project.addedAt);
        for (const chat of chats) {
            if (!removed.includes(chat.cwd)) see(chat.cwd, chat.createdAt);
        }
        return [...first].sort((a, b) => a[1] - b[1]).map(([path]) => path);
    }, [saved, removed, chats]);
}

/** Same actions outside React. */
export const projects = {
    add: (path: string) => useProjectsStore.getState().add(path),
    remove: (path: string) => useProjectsStore.getState().remove(path)
};
