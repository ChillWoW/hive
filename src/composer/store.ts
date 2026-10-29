import { useMemo } from "react";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { Attachment, ChatConfig } from "@/proto";
import { isImage, primeAttachmentUrl, saveAttachment } from "@/attachments";

/** New-chat drafts are keyed `new:<uuid>`; chat ids are UUIDs, so they can't collide. */
const NEW_PREFIX = "new:";
const mintNewKey = () => `${NEW_PREFIX}${crypto.randomUUID()}`;
export const isNewDraftKey = (key: string) => key.startsWith(NEW_PREFIX);

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

/** A new-chat draft that isn't the one open in the new-chat view. */
export type ParkedDraft = {
    /** The new chat's settings as they were when it was left. */
    settings: NewChatSettings;
    /** When it was left. */
    at: number;
};

type ComposerState = {
    /**
     * Unsent text by chat id, or a new-chat draft's `new:` key, so a
     * half-written prompt survives switching chats and restarts. Empty
     * drafts are dropped.
     */
    drafts: Record<string, string>;
    /** Files attached to each draft, by the same keys. */
    attachments: Record<string, DraftAttachment[]>;
    /** The new-chat draft the new-chat view edits (with `newChat`). */
    newDraftId: string;
    /** The other new-chat drafts, by key; their text is in `drafts`. */
    parked: Record<string, ParkedDraft>;
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
    /**
     * Gives the new-chat view a blank draft (in `cwd` if given), parking the
     * open one if it has anything in it.
     */
    startNewChat: (cwd?: string) => void;
    /** Makes a parked new-chat draft the one the new-chat view edits. */
    openDraft: (key: string) => void;
    /** Throws a draft away: its text, files and, for a new chat, its settings. */
    discardDraft: (key: string) => void;
    /** Drops the drafts of chats that are gone. */
    pruneDrafts: (chatIds: Set<string>) => void;
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
                    const key = chatId ?? s.newDraftId;
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
                    const key = chatId ?? s.newDraftId;
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
            newDraftId: mintNewKey(),
            parked: {},
            startNewChat: (cwd) =>
                set((s) => {
                    const newChat = cwd ? { ...s.newChat, cwd, base: null } : s.newChat;
                    if (isEmpty(s, s.newDraftId)) return { newChat };
                    return {
                        ...park(s),
                        newDraftId: mintNewKey(),
                        newChat: { ...newChat, base: null }
                    };
                }),
            openDraft: (key) =>
                set((s) => {
                    const draft = s.parked[key];
                    if (key === s.newDraftId || !draft) return s;
                    const { [key]: _, ...parked } = park(s).parked;
                    return { parked, newDraftId: key, newChat: draft.settings };
                }),
            discardDraft: (key) =>
                set((s) => {
                    for (const a of s.attachments[key] ?? []) {
                        if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
                    }
                    const { [key]: _d, ...drafts } = s.drafts;
                    const { [key]: _a, ...attachments } = s.attachments;
                    const { [key]: _p, ...parked } = s.parked;
                    return { drafts, attachments, parked };
                }),
            pruneDrafts: (chatIds) =>
                set((s) => {
                    const gone = (key: string) => !isNewDraftKey(key) && !chatIds.has(key);
                    const keys = [...Object.keys(s.drafts), ...Object.keys(s.attachments)];
                    if (!keys.some(gone)) return s;
                    const keep = <T,>(record: Record<string, T>) =>
                        Object.fromEntries(Object.entries(record).filter(([k]) => !gone(k)));
                    return { drafts: keep(s.drafts), attachments: keep(s.attachments) };
                }),
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
            // Drafts keep their copied files (the copies outlive a restart;
            // see `sweep_attachments`), not ones still copying or failed.
            partialize: (s) => ({
                newChat: {
                    ...s.newChat,
                    base: null,
                    config: { ...s.newChat.config, plan: false }
                },
                favorites: s.favorites,
                drafts: s.drafts,
                attachments: Object.fromEntries(
                    Object.entries(s.attachments).flatMap(([key, list]) => {
                        const kept = list.flatMap(({ previewUrl: _, ...a }) =>
                            a.attachment ? [a] : []
                        );
                        return kept.length ? [[key, kept]] : [];
                    })
                ),
                newDraftId: s.newDraftId,
                parked: s.parked
            }),
            // Settings saved before access modes existed lack them.
            merge: (saved, current) => {
                const persisted = saved as Partial<ComposerState> | undefined;
                const favorites = Array.isArray(persisted?.favorites)
                    ? persisted.favorites
                    : current.favorites;
                const restored = {
                    favorites,
                    drafts: isRecord(persisted?.drafts) ? persisted.drafts : current.drafts,
                    attachments: isRecord(persisted?.attachments)
                        ? persisted.attachments
                        : current.attachments,
                    newDraftId:
                        typeof persisted?.newDraftId === "string"
                            ? persisted.newDraftId
                            : current.newDraftId,
                    parked: isRecord(persisted?.parked) ? persisted.parked : current.parked
                };
                const newChat = persisted?.newChat;
                if (!newChat) return { ...current, ...restored };
                return {
                    ...current,
                    ...restored,
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

/** A draft's key: the chat's id, or the open new-chat draft's for null. */
function keyOf(chatId: string | null) {
    return chatId ?? useComposerStore.getState().newDraftId;
}

function isEmpty(s: ComposerState, key: string) {
    return !s.drafts[key]?.trim() && !s.attachments[key]?.length;
}

/** Parks the open new-chat draft, if it has anything in it. */
function park(s: ComposerState): Pick<ComposerState, "parked"> {
    if (isEmpty(s, s.newDraftId)) return { parked: s.parked };
    return {
        parked: { ...s.parked, [s.newDraftId]: { settings: s.newChat, at: Date.now() } }
    };
}

function isRecord<T>(value: Record<string, T> | undefined): value is Record<string, T> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function useDraft(chatId: string | null): string {
    return useComposerStore((s) => s.drafts[chatId ?? s.newDraftId] ?? "");
}

const NO_ATTACHMENTS: DraftAttachment[] = [];

export function useDraftAttachments(chatId: string | null): DraftAttachment[] {
    return useComposerStore((s) => s.attachments[chatId ?? s.newDraftId] ?? NO_ATTACHMENTS);
}

/** Whether the chat has unsent text or files. */
export function useHasDraft(chatId: string): boolean {
    return useComposerStore((s) => !isEmpty(s, chatId));
}

/** A new-chat draft as the sidebar lists it. */
export type NewChatDraft = {
    key: string;
    text: string;
    files: number;
    cwd: string | null;
    /** The one the new-chat view edits. */
    open: boolean;
};

/** New-chat drafts with something in them: the open one, then newest first. */
export function useNewChatDrafts(): NewChatDraft[] {
    const drafts = useComposerStore((s) => s.drafts);
    const attachments = useComposerStore((s) => s.attachments);
    const newDraftId = useComposerStore((s) => s.newDraftId);
    const cwd = useComposerStore((s) => s.newChat.cwd);
    const parked = useComposerStore((s) => s.parked);

    return useMemo(() => {
        const keys = new Set([...Object.keys(drafts), ...Object.keys(attachments)]);
        const list: (NewChatDraft & { at: number })[] = [];
        for (const key of keys) {
            if (!isNewDraftKey(key)) continue;
            const text = drafts[key]?.trim() ?? "";
            const files = attachments[key]?.length ?? 0;
            if (!text && !files) continue;
            const open = key === newDraftId;
            const left = parked[key];
            list.push({
                key,
                text,
                files,
                cwd: open ? cwd : (left?.settings.cwd ?? null),
                open,
                at: open ? Infinity : (left?.at ?? 0)
            });
        }
        return list.sort((a, b) => b.at - a.at);
    }, [drafts, attachments, newDraftId, cwd, parked]);
}

/** Same actions outside React. */
export const composer = {
    draft: (chatId: string | null) =>
        useComposerStore.getState().drafts[keyOf(chatId)] ?? "",
    setDraft: (chatId: string | null, text: string) =>
        useComposerStore.getState().setDraft(chatId, text),
    restoreAttachments: (chatId: string | null, attachments: Attachment[]) =>
        useComposerStore.getState().restoreAttachments(chatId, attachments),
    focus: () => useComposerStore.getState().focus(),
    startNewChat: (cwd?: string) => useComposerStore.getState().startNewChat(cwd),
    openDraft: (key: string) => useComposerStore.getState().openDraft(key),
    discardDraft: (key: string) => useComposerStore.getState().discardDraft(key),
    pruneDrafts: (chatIds: Set<string>) => useComposerStore.getState().pruneDrafts(chatIds)
};
