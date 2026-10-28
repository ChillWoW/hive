import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { ChatConfig } from "@/proto";

/** The new-chat view's draft key; chat ids are UUIDs, so it can't collide. */
const NEW_CHAT = "";

const keyOf = (chatId: string | null) => chatId ?? NEW_CHAT;

/** What the next new chat is created with. */
export type NewChatSettings = {
    /** Null until a folder is picked. */
    cwd: string | null;
    config: ChatConfig;
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
    setDraft: (chatId: string | null, text: string) => void;
    focus: () => void;
    setNewChat: (patch: Partial<NewChatSettings>) => void;
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
                config: {
                    harness: "claude-code",
                    modelOptions: {},
                    sandbox: "workspace-write"
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
                set((s) => ({ newChat: { ...s.newChat, ...patch } }))
        }),
        {
            name: "hive.composer",
            storage: createJSONStorage(() => localStorage),
            partialize: (s) => ({ newChat: s.newChat })
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
