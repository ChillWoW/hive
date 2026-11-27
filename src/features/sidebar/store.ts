import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { Chat } from "@/proto";
import type { LiveStatus } from "./status";

export const ARCHIVED = "archived";
export const projectKey = (path: string) => `project:${path}`;

type SidebarState = {
    /** Groups the user folded or unfolded, by key; the rest use their default. */
    collapsed: Record<string, boolean>;
    /** The chat whose title is being edited in place. */
    renaming: string | null;
    /** The search field's text; filters the list while not blank. */
    query: string;
    /** Shows only chats with this status, while any has it (`activeFilter`). */
    filter: LiveStatus | null;
    /** Each chat's latest message when the user last left it, by chat id. */
    seen: Record<string, number>;
    /** When this device started tracking `seen`: a chat never opened counts as seen up to here. */
    since: number;
    toggle: (key: string) => void;
    setRenaming: (chatId: string | null) => void;
    setQuery: (query: string) => void;
    setFilter: (filter: LiveStatus | null) => void;
    markSeen: (chatId: string, at: number) => void;
    /** Forgets chats that are gone. */
    pruneSeen: (ids: Set<string>) => void;
};

/** Archived starts folded; everything else starts open. */
export function isCollapsed(collapsed: Record<string, boolean>, key: string) {
    return collapsed[key] ?? key === ARCHIVED;
}

/**
 * Whether the chat has replies the user hasn't seen: newer than when they
 * last left it or, for a chat they never opened (one an agent started),
 * than `since`.
 */
export function isUnread(chat: Chat, seen: Record<string, number>, since: number) {
    return chat.lastMessageAt != null && chat.lastMessageAt > (seen[chat.id] ?? since);
}

/** Fold and seen state persist per device (localStorage); renaming, search and the filter don't. */
export const useSidebarStore = create<SidebarState>()(
    persist(
        (set) => ({
            collapsed: {},
            renaming: null,
            query: "",
            filter: null,
            seen: {},
            since: Date.now(),
            toggle: (key) =>
                set((s) => ({
                    collapsed: { ...s.collapsed, [key]: !isCollapsed(s.collapsed, key) }
                })),
            setRenaming: (chatId) => set({ renaming: chatId }),
            setQuery: (query) => set({ query }),
            setFilter: (filter) => set({ filter }),
            markSeen: (chatId, at) =>
                set((s) => (s.seen[chatId] === at ? s : { seen: { ...s.seen, [chatId]: at } })),
            pruneSeen: (ids) =>
                set((s) => {
                    const kept = Object.entries(s.seen).filter(([id]) => ids.has(id));
                    return kept.length === Object.keys(s.seen).length ? s : { seen: Object.fromEntries(kept) };
                })
        }),
        {
            name: "outcode.sidebar",
            storage: createJSONStorage(() => localStorage),
            partialize: (s) => ({ collapsed: s.collapsed, seen: s.seen, since: s.since })
        }
    )
);
