import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { Chat, ChatsUpdate } from "@/proto";
import { chatsApi } from "./api";

type ChatsState = {
    /** The first snapshot came. */
    loaded: boolean;
    /** Every chat, most recently active first. */
    chats: Chat[];
    /** Chats whose turn is running. */
    working: Record<string, true>;
    /** The chat the main pane shows; null for the new-chat view. Survives a reload. */
    activeChatId: string | null;
    /** Where the new-chat view's next chat will run. Survives a reload. */
    newChatCwd: string | null;
    select: (chatId: string | null) => void;
    setNewChatCwd: (cwd: string | null) => void;
    apply: (update: ChatsUpdate) => void;
};

/** When a chat was last active: its latest message, else its creation. */
export const activity = (chat: Chat) => chat.lastMessageAt ?? chat.createdAt;

const byActivity = (a: Chat, b: Chat) => activity(b) - activity(a);

export const useChatsStore = create<ChatsState>()(
    persist(
        (set) => ({
            loaded: false,
            chats: [],
            working: {},
            activeChatId: null,
            newChatCwd: null,
            select: (activeChatId) => set({ activeChatId }),
            setNewChatCwd: (newChatCwd) => set({ newChatCwd }),
            apply: (update) =>
                set((s) => {
                    switch (update.kind) {
                        case "snapshot": {
                            const chats = [...update.chats].sort(byActivity);
                            const known = chats.some((c) => c.id === s.activeChatId);
                            return {
                                loaded: true,
                                chats,
                                working: Object.fromEntries(update.working.map((id) => [id, true])),
                                // A chat deleted while the app was closed.
                                activeChatId: known ? s.activeChatId : null
                            };
                        }
                        case "upsert": {
                            const rest = s.chats.filter((c) => c.id !== update.chat.id);
                            return { chats: [...rest, update.chat].sort(byActivity) };
                        }
                        case "removed": {
                            const { [update.id]: _, ...working } = s.working;
                            return {
                                chats: s.chats.filter((c) => c.id !== update.id),
                                working,
                                activeChatId: s.activeChatId === update.id ? null : s.activeChatId
                            };
                        }
                        case "working": {
                            const { [update.chatId]: _, ...working } = s.working;
                            return { working: update.working ? { ...working, [update.chatId]: true } : working };
                        }
                    }
                })
        }),
        {
            name: "outcode.chats",
            storage: createJSONStorage(() => localStorage),
            partialize: (s) => ({ activeChatId: s.activeChatId, newChatCwd: s.newChatCwd })
        }
    )
);

/** The chat the main pane shows, if any. */
export function useActiveChat(): Chat | undefined {
    return useChatsStore((s) => s.chats.find((c) => c.id === s.activeChatId));
}

/** Chat actions, outside React too. Changes come back through the watcher. */
export const chats = {
    select: (chatId: string | null) => useChatsStore.getState().select(chatId),
    /** Opens the new-chat view, in `cwd` when given. */
    startNew: (cwd?: string) => {
        const state = useChatsStore.getState();
        if (cwd) state.setNewChatCwd(cwd);
        state.select(null);
    },
    rename: (chatId: string, title: string | null) => chatsApi.rename(chatId, title),
    setPinned: (chatId: string, pinned: boolean) => chatsApi.setPinned(chatId, pinned),
    setArchived: (chatId: string, archived: boolean) => chatsApi.setArchived(chatId, archived),
    remove: (chatId: string) => chatsApi.remove(chatId)
};
