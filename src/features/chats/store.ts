import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { Chat, ChatsUpdate, Session } from "@/proto";
import { chatsApi } from "./api";

type ChatsState = {
    /** The first snapshot came. */
    loaded: boolean;
    /** Every chat, most recently active first. */
    chats: Chat[];
    /** Chats' live state (running, queued prompts, background tasks, context), by chat id. */
    sessions: Record<string, Session>;
    /** The chat the main pane shows; null for the new-chat view. Survives a reload. */
    activeChatId: string | null;
    /** Where the new-chat view's next chat will run. Survives a reload. */
    newChatCwd: string | null;
    /**
     * The subagent thread shown in the active chat: spawn ids from the
     * outermost in; empty for the chat itself. Cleared when the chat changes.
     */
    subagent: string[];
    select: (chatId: string | null) => void;
    /** Shows a subagent thread in the active chat: `path` of spawn ids, outermost first. */
    openSubagentPath: (path: string[]) => void;
    setNewChatCwd: (cwd: string | null) => void;
    apply: (update: ChatsUpdate) => void;
};

/** When a chat was last active: its latest message, else its creation. */
export const activity = (chat: Chat) => chat.lastMessageAt ?? chat.createdAt;

/** Where the chat's agent works: its worktree, else its folder (`Chat::work_dir`). */
export const workDir = (chat: Chat) => chat.worktree?.path ?? chat.cwd;

const byActivity = (a: Chat, b: Chat) => activity(b) - activity(a);

// When this window first saw each background task: the CLIs don't say when one started.
const taskSeen = new Map<string, number>();

function stampTasks(sessions: Session[]) {
    const now = Date.now();
    for (const session of sessions) {
        for (const task of session.tasks) if (!taskSeen.has(task.id)) taskSeen.set(task.id, now);
    }
}

/** When a background task started, as near as this window knows. */
export const taskStartedAt = (taskId: string) => taskSeen.get(taskId);

export const useChatsStore = create<ChatsState>()(
    persist(
        (set) => ({
            loaded: false,
            chats: [],
            sessions: {},
            activeChatId: null,
            newChatCwd: null,
            subagent: [],
            select: (activeChatId) => set({ activeChatId, subagent: [] }),
            openSubagentPath: (subagent) => set({ subagent }),
            setNewChatCwd: (newChatCwd) => set({ newChatCwd }),
            apply: (update) => {
                if (update.kind === "snapshot") stampTasks(update.sessions);
                else if (update.kind === "session") stampTasks([update.session]);
                set((s): Partial<ChatsState> => {
                    switch (update.kind) {
                        case "snapshot": {
                            const chats = [...update.chats].sort(byActivity);
                            const known = chats.some((c) => c.id === s.activeChatId);
                            return {
                                loaded: true,
                                chats,
                                sessions: Object.fromEntries(update.sessions.map((x) => [x.chatId, x])),
                                // A chat deleted while the app was closed.
                                activeChatId: known ? s.activeChatId : null,
                                subagent: known ? s.subagent : []
                            };
                        }
                        case "upsert": {
                            const rest = s.chats.filter((c) => c.id !== update.chat.id);
                            return { chats: [...rest, update.chat].sort(byActivity) };
                        }
                        case "removed": {
                            const { [update.id]: _, ...sessions } = s.sessions;
                            const active = s.activeChatId === update.id;
                            return {
                                chats: s.chats.filter((c) => c.id !== update.id),
                                sessions,
                                activeChatId: active ? null : s.activeChatId,
                                subagent: active ? [] : s.subagent
                            };
                        }
                        case "session":
                            return { sessions: { ...s.sessions, [update.session.chatId]: update.session } };
                    }
                });
            }
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

/** A chat's live state; undefined while it has none. */
export const useSession = (chatId: string | null | undefined) =>
    useChatsStore((s) => (chatId ? s.sessions[chatId] : undefined));

/** Whether the chat's turn is running. */
export const useWorking = (chatId: string | null | undefined) =>
    useChatsStore((s) => !!chatId && !!s.sessions[chatId]?.working);

/** Chat actions, outside React too. Changes come back through the watcher. */
export const chats = {
    select: (chatId: string | null) => useChatsStore.getState().select(chatId),
    /** Opens a subagent's thread, one level in from the one shown. */
    openSubagent: (id: string) => {
        const state = useChatsStore.getState();
        state.openSubagentPath([...state.subagent, id]);
    },
    /** Shows the thread `depth` levels in (0: the chat itself; -1: the shown one's parent). */
    openSubagentDepth: (depth: number) => {
        const state = useChatsStore.getState();
        state.openSubagentPath(state.subagent.slice(0, depth));
    },
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
