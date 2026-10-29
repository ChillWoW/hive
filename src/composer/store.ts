import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { ChatConfig } from "@/proto";

/** The new-chat view's draft key; chat ids are UUIDs, so it can't collide. */
const NEW_CHAT = "";

const keyOf = (chatId: string | null) => chatId ?? NEW_CHAT;

/**
 * Where a new chat works: the folder's own checkout, or a worktree made for
 * it (a new branch in a folder of its own).
 */
export type Workspace = "local" | "worktree";

/** What the next new chat is created with. */
export type NewChatSettings = {
    /** Null until a folder is picked. */
    cwd: string | null;
    config: ChatConfig;
    workspace: Workspace;
    /** The branch a worktree starts from; null for the checked-out one. */
    base: string | null;
};

type ComposerState = {
    /**
     * Unsent text by chat id (`NEW_CHAT` for the new-chat view), so a
     * half-written prompt survives switching chats. Empty drafts are dropped.
     */
    drafts: Record<string, string>;
    /** Bumped to ask the composer for the caret back. */
    focusToken: number;
    newChat: NewChatSettings;
    /** Starred models as `harness/model`, listed first in the model picker. */
    favorites: string[];
    setDraft: (chatId: string | null, text: string) => void;
    focus: () => void;
    setNewChat: (patch: Partial<NewChatSettings>) => void;
    toggleFavorite: (key: string) => void;
};

/**
 * Drafts live here rather than in the composer, so they outlive it: the
 * composer unmounts when the question wizard takes its place, or when the
 * user switches chats. The new chat's settings are remembered across
 * launches, per device (localStorage), since they're a convenience.
 */
export const useComposerStore = create<ComposerState>()(
    persist(
        (set) => ({
            drafts: {},
            focusToken: 0,
            newChat: {
                cwd: null,
                workspace: "local",
                base: null,
                config: {
                    harness: "claude-code",
                    modelOptions: {},
                    sandbox: "workspace-write",
                    access: "full-access",
                    plan: false
                }
            },
            setDraft: (chatId, text) =>
                set((s) => {
                    const key = keyOf(chatId);
                    if ((s.drafts[key] ?? "") === text) return s;
                    const { [key]: _, ...rest } = s.drafts;
                    return { drafts: text ? { ...rest, [key]: text } : rest };
                }),
            focus: () => set((s) => ({ focusToken: s.focusToken + 1 })),
            setNewChat: (patch) =>
                set((s) => ({ newChat: { ...s.newChat, ...patch } })),
            favorites: [],
            toggleFavorite: (key) =>
                set((s) => ({
                    favorites: s.favorites.includes(key)
                        ? s.favorites.filter((k) => k !== key)
                        : [...s.favorites, key]
                }))
        }),
        {
            name: "hive.composer",
            storage: createJSONStorage(() => localStorage),
            // The access mode and workspace are remembered; plan mode and the
            // worktree's base are for the chat at hand.
            partialize: (s) => ({
                newChat: {
                    ...s.newChat,
                    base: null,
                    config: { ...s.newChat.config, plan: false }
                },
                favorites: s.favorites
            }),
            // Settings saved before access modes existed lack them.
            merge: (saved, current) => {
                const persisted = saved as Partial<ComposerState> | undefined;
                const favorites = Array.isArray(persisted?.favorites)
                    ? persisted.favorites
                    : current.favorites;
                const newChat = persisted?.newChat;
                if (!newChat) return { ...current, favorites };
                return {
                    ...current,
                    favorites,
                    newChat: {
                        ...current.newChat,
                        ...newChat,
                        config: { ...current.newChat.config, ...newChat.config }
                    }
                };
            }
        }
    )
);

export function useDraft(chatId: string | null): string {
    return useComposerStore((s) => s.drafts[keyOf(chatId)] ?? "");
}

/** Same actions outside React. */
export const composer = {
    draft: (chatId: string | null) =>
        useComposerStore.getState().drafts[keyOf(chatId)] ?? "",
    setDraft: (chatId: string | null, text: string) =>
        useComposerStore.getState().setDraft(chatId, text),
    focus: () => useComposerStore.getState().focus()
};
