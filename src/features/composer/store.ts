import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { Attachment, ChatConfig } from "@/proto";

/** The new-chat view's draft key; chat ids are UUIDs, so they can't collide. */
const NEW = "new";
const keyOf = (chatId: string | null) => chatId ?? NEW;

/**
 * Where a new chat works: the folder's own checkout, or a worktree made for
 * it as its first prompt is sent (a new branch in a folder of its own).
 */
export type Workspace = "local" | "worktree";

type ComposerState = {
    /**
     * Unsent text by chat id (the new-chat view's under `new`), so a
     * half-written prompt survives switching chats and restarts. Empty
     * drafts are dropped.
     */
    drafts: Record<string, string>;
    /** Files attached to the unsent prompt, by the same keys as `drafts`. */
    attachments: Record<string, Attachment[]>;
    /** What the next new chat runs on, once picked; else Settings' defaults. */
    newChatConfig: ChatConfig | null;
    /** Where the next new chat works. Remembered. */
    newChatWorkspace: Workspace;
    /** The branch a new chat's worktree starts from; null for the checked-out one. Not remembered. */
    newChatBase: string | null;
    /** Bumped to ask the composer for the caret back. */
    focusToken: number;
    setDraft: (chatId: string | null, text: string) => void;
    setAttachments: (chatId: string | null, attachments: Attachment[]) => void;
    setNewChatConfig: (config: ChatConfig | null) => void;
    setNewChatWorkspace: (workspace: Workspace) => void;
    setNewChatBase: (base: string | null) => void;
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
            attachments: {},
            newChatConfig: null,
            newChatWorkspace: "local",
            newChatBase: null,
            focusToken: 0,
            setDraft: (chatId, text) =>
                set((s) => {
                    const key = keyOf(chatId);
                    const { [key]: _, ...rest } = s.drafts;
                    return { drafts: text ? { ...rest, [key]: text } : rest };
                }),
            setAttachments: (chatId, attachments) =>
                set((s) => {
                    const key = keyOf(chatId);
                    const { [key]: _, ...rest } = s.attachments;
                    return { attachments: attachments.length ? { ...rest, [key]: attachments } : rest };
                }),
            setNewChatConfig: (newChatConfig) => set({ newChatConfig }),
            setNewChatWorkspace: (newChatWorkspace) => set({ newChatWorkspace }),
            setNewChatBase: (newChatBase) => set({ newChatBase }),
            focus: () => set((s) => ({ focusToken: s.focusToken + 1 })),
            pruneDrafts: (chatIds) =>
                set((s) => {
                    const live = ([key]: [string, unknown]) => key === NEW || chatIds.has(key);
                    const kept = Object.entries(s.drafts).filter(live);
                    const files = Object.entries(s.attachments).filter(live);
                    // Unchanged: the same state, so nothing re-renders or saves.
                    if (
                        kept.length === Object.keys(s.drafts).length &&
                        files.length === Object.keys(s.attachments).length
                    ) {
                        return s;
                    }
                    return { drafts: Object.fromEntries(kept), attachments: Object.fromEntries(files) };
                })
        }),
        {
            name: "outcode.composer",
            storage: createJSONStorage(() => localStorage),
            // The worktree's base is for the chat at hand.
            partialize: (s) => ({
                drafts: s.drafts,
                attachments: s.attachments,
                newChatConfig: s.newChatConfig,
                newChatWorkspace: s.newChatWorkspace
            })
        }
    )
);

/** The chat's unsent text (the new-chat view's for null). */
export const useDraft = (chatId: string | null) =>
    useComposerStore((s) => s.drafts[keyOf(chatId)] ?? "");

/** Same actions outside React. */
export const composer = {
    draft: (chatId: string | null) => useComposerStore.getState().drafts[keyOf(chatId)] ?? "",
    setDraft: (chatId: string | null, text: string) =>
        useComposerStore.getState().setDraft(chatId, text),
    focus: () => useComposerStore.getState().focus(),
    /** Moves a chat's unsent text and files to another, as a handoff to a new chat does. */
    moveDraft: (from: string, to: string) => {
        const state = useComposerStore.getState();
        const text = state.drafts[keyOf(from)] ?? "";
        const files = state.attachments[keyOf(from)] ?? [];
        state.setDraft(to, text);
        state.setAttachments(to, files);
        state.setDraft(from, "");
        state.setAttachments(from, []);
    }
};

const NO_ATTACHMENTS: Attachment[] = [];

/** The files attached to the chat's unsent prompt. */
export const useDraftAttachments = (chatId: string | null) =>
    useComposerStore((s) => s.attachments[keyOf(chatId)] ?? NO_ATTACHMENTS);

/** Attaches more files to the chat's unsent prompt. */
export function addDraftAttachments(chatId: string | null, added: Attachment[]) {
    const state = useComposerStore.getState();
    state.setAttachments(chatId, [...(state.attachments[keyOf(chatId)] ?? []), ...added]);
}
