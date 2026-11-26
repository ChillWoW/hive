import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { Chat } from "@/proto";

export const ACTIVE = "active";
export const PINNED = "pinned";
export const ARCHIVED = "archived";
export const projectKey = (path: string) => `project:${path}`;

type SidebarState = {
    /** Sections the user folded or unfolded, by key; the rest use their default. */
    collapsed: Record<string, boolean>;
    /** The chat whose title is being edited in place. */
    renaming: string | null;
    /** The search field's text; filters the list while not blank. */
    query: string;
    /** Each chat's latest message when the user last left it, by chat id. */
    seen: Record<string, number>;
    toggle: (key: string) => void;
    setRenaming: (chatId: string | null) => void;
    setQuery: (query: string) => void;
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
 * last left it. A chat never left counts as seen.
 */
export function isUnread(chat: Chat, seen: Record<string, number>) {
    const at = seen[chat.id];
    return at !== undefined && chat.lastMessageAt != null && chat.lastMessageAt > at;
}

/** Fold and seen state persist per device (localStorage); renaming and search don't. */
export const useSidebarStore = create<SidebarState>()(
    persist(
        (set) => ({
            collapsed: {},
            renaming: null,
            query: "",
            seen: {},
            toggle: (key) =>
                set((s) => ({
                    collapsed: { ...s.collapsed, [key]: !isCollapsed(s.collapsed, key) }
                })),
            setRenaming: (chatId) => set({ renaming: chatId }),
            setQuery: (query) => set({ query }),
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
            partialize: (s) => ({ collapsed: s.collapsed, seen: s.seen })
        }
    )
);
