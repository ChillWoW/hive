import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { Attachment, ChatConfig } from "@/proto";
import { isImage, primeAttachmentUrl, saveAttachment } from "@/attachments";

/** The new-chat view's draft key; chat ids are UUIDs, so it can't collide. */
const NEW_CHAT = "";

const keyOf = (chatId: string | null) => chatId ?? NEW_CHAT;

/**
 * Where a new chat works: the folder's own checkout, or a worktree made for
 * it (a new branch in a folder of its own).
 */
export type Workspace = "local" | "worktree";

/** A file in a draft: being copied in, copied (`attachment`), or failed. */
export type DraftAttachment = {
    id: string;
    name: string;
    mimeType: string;
    /** An image's thumbnail, as an object URL. */
    previewUrl?: string;
    attachment?: Attachment;
    error?: string;
};

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
    /** Files attached to each draft, by the same keys. */
    attachments: Record<string, DraftAttachment[]>;
    /** Bumped to ask the composer for the caret back. */
    focusToken: number;
    newChat: NewChatSettings;
    /** Starred models as `harness/model`, listed first in the model picker. */
    favorites: string[];
    setDraft: (chatId: string | null, text: string) => void;
    /** Attaches `files`, copying each in. */
    addFiles: (chatId: string | null, files: File[]) => void;
    /** Puts already copied files back, as when a queued prompt is edited. */
    restoreAttachments: (chatId: string | null, attachments: Attachment[]) => void;
    removeAttachment: (chatId: string | null, id: string) => void;
    /** Empties the draft's files, returning the copied ones (to send). */
    takeAttachments: (chatId: string | null) => Attachment[];
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
            attachments: {},
            addFiles: (chatId, files) => {
                const key = keyOf(chatId);
                const added: DraftAttachment[] = files.map((file) => ({
                    id: crypto.randomUUID(),
                    name: file.name || "file",
                    mimeType: file.type || "application/octet-stream",
                    previewUrl: isImage(file.type) ? URL.createObjectURL(file) : undefined
                }));
                set((s) => ({
                    attachments: {
                        ...s.attachments,
                        [key]: [...(s.attachments[key] ?? []), ...added]
                    }
                }));
                const update = (id: string, patch: Partial<DraftAttachment>) =>
                    set((s) => {
                        const list = s.attachments[key];
                        if (!list?.some((a) => a.id === id)) return s;
                        return {
                            attachments: {
                                ...s.attachments,
                                [key]: list.map((a) => (a.id === id ? { ...a, ...patch } : a))
                            }
                        };
                    });
                files.forEach((file, i) => {
                    const { id } = added[i];
                    saveAttachment(file)
                        .then((attachment) =>
                            update(id, { attachment, mimeType: attachment.mimeType })
                        )
                        .catch((error: unknown) =>
                            update(id, {
                                error: error instanceof Error ? error.message : String(error)
                            })
                        );
                });
            },
            restoreAttachments: (chatId, restored) => {
                if (restored.length === 0) return;
                const key = keyOf(chatId);
                set((s) => ({
                    attachments: {
                        ...s.attachments,
                        [key]: [
                            ...(s.attachments[key] ?? []),
                            ...restored.map((attachment) => ({
                                id: crypto.randomUUID(),
                                name: attachment.name,
                                mimeType: attachment.mimeType,
                                attachment
                            }))
                        ]
                    }
                }));
            },
            removeAttachment: (chatId, id) =>
                set((s) => {
                    const key = keyOf(chatId);
                    const list = s.attachments[key] ?? [];
                    const gone = list.find((a) => a.id === id);
                    if (!gone) return s;
                    if (gone.previewUrl) URL.revokeObjectURL(gone.previewUrl);
                    const rest = list.filter((a) => a !== gone);
                    const { [key]: _, ...others } = s.attachments;
                    return { attachments: rest.length ? { ...others, [key]: rest } : others };
                }),
            takeAttachments: (chatId) => {
                const key = keyOf(chatId);
                const list = useComposerStore.getState().attachments[key] ?? [];
                const sent: Attachment[] = [];
                for (const a of list) {
                    if (a.attachment) {
                        sent.push(a.attachment);
                        // The transcript shows the same image; it takes the URL over.
                        if (a.previewUrl) primeAttachmentUrl(a.attachment, a.previewUrl);
                    } else if (a.previewUrl) {
                        URL.revokeObjectURL(a.previewUrl);
                    }
                }
                set((s) => {
                    const { [key]: _, ...others } = s.attachments;
                    return { attachments: others };
                });
                return sent;
            },
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

const NO_ATTACHMENTS: DraftAttachment[] = [];

export function useDraftAttachments(chatId: string | null): DraftAttachment[] {
    return useComposerStore((s) => s.attachments[keyOf(chatId)] ?? NO_ATTACHMENTS);
}

/** Same actions outside React. */
export const composer = {
    draft: (chatId: string | null) =>
        useComposerStore.getState().drafts[keyOf(chatId)] ?? "",
    setDraft: (chatId: string | null, text: string) =>
        useComposerStore.getState().setDraft(chatId, text),
    restoreAttachments: (chatId: string | null, attachments: Attachment[]) =>
        useComposerStore.getState().restoreAttachments(chatId, attachments),
    focus: () => useComposerStore.getState().focus()
};
