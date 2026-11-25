import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { ChatConfig } from "@/proto";

/** The new-chat view's draft key; chat ids are UUIDs, so they can't collide. */
const NEW = "new";
const keyOf = (chatId: string | null) => chatId ?? NEW;

type ComposerState = {
    /**
     * Unsent text by chat id (the new-chat view's under `new`), so a
     * half-written prompt survives switching chats and restarts. Empty
     * drafts are dropped.
     */
    drafts: Record<string, string>;
    /** What the next new chat runs on, once picked; else Settings' defaults. */
    newChatConfig: ChatConfig | null;
    /** Bumped to ask the composer for the caret back. */
    focusToken: number;
    setDraft: (chatId: string | null, text: string) => void;
    setNewChatConfig: (config: ChatConfig | null) => void;
    focus: () => void;
    /** Drops the drafts of chats that are gone. */
    pruneDrafts: (chatIds: Set<string>) => void;
};

/**
 * Drafts live here rather than in the composer so they outlive it. Kept per
 * device (localStorage), as is the new chat's config: both conveniences.
 */
export const useComposerStore = create<ComposerState>()(
    persist(
        (set) => ({
            drafts: {},
            newChatConfig: null,
            focusToken: 0,
            setDraft: (chatId, text) =>
                set((s) => {
                    const key = keyOf(chatId);
                    const { [key]: _, ...rest } = s.drafts;
                    return { drafts: text ? { ...rest, [key]: text } : rest };
                }),
            setNewChatConfig: (newChatConfig) => set({ newChatConfig }),
            focus: () => set((s) => ({ focusToken: s.focusToken + 1 })),
            pruneDrafts: (chatIds) =>
                set((s) => {
                    const kept = Object.entries(s.drafts).filter(
                        ([key]) => key === NEW || chatIds.has(key)
                    );
                    // Unchanged: the same state, so nothing re-renders or saves.
                    if (kept.length === Object.keys(s.drafts).length) return s;
                    return { drafts: Object.fromEntries(kept) };
                })
        }),
        {
            name: "outcode.composer",
            storage: createJSONStorage(() => localStorage),
            partialize: (s) => ({ drafts: s.drafts, newChatConfig: s.newChatConfig })
        }
    )
);

/** The chat's unsent text (the new-chat view's for null). */
export const useDraft = (chatId: string | null) =>
    useComposerStore((s) => s.drafts[keyOf(chatId)] ?? "");

/** Same actions outside React. */
export const composer = {
    setDraft: (chatId: string | null, text: string) =>
        useComposerStore.getState().setDraft(chatId, text),
    focus: () => useComposerStore.getState().focus()
};
