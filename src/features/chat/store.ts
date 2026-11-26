import { create } from "zustand";
import type { Attachment, InputResponse, Message, MessagesUpdate } from "@/proto";
import { chatsApi, type Unwatch } from "@/features/chats/api";
import { chats, useChatsStore } from "@/features/chats/store";
import { toast } from "@/ui";
import { newChatConfig } from "./config";
import { foldEvent, stampEvent } from "./fold";

type ChatState = {
    /** The chat whose messages these are. */
    chatId: string | null;
    messages: Message[];
    /** Its snapshot came. */
    loaded: boolean;
    apply: (chatId: string, update: MessagesUpdate) => void;
};

export const useChatStore = create<ChatState>()((set, get) => ({
    chatId: null,
    messages: [],
    loaded: false,
    apply: (chatId, update) => {
        if (chatId !== get().chatId) return;
        switch (update.kind) {
            case "snapshot":
                return set({ messages: update.messages, loaded: true });
            case "upsert": {
                const { message } = update;
                return set((s) => {
                    const at = s.messages.findIndex((m) => m.id === message.id);
                    if (at < 0) return { messages: [...s.messages, message] };
                    return { messages: s.messages.with(at, message) };
                });
            }
            case "event":
                return set((s) => ({
                    messages: s.messages.map((m) =>
                        m.id === update.messageId
                            ? { ...m, parts: stampEvent(foldEvent(m.parts, update.event), update.event, Date.now()) }
                            : m
                    )
                }));
        }
    }
}));

/** The open watch: its chat, and a promise settled once it's registered. */
let watching: { chatId: string | null; ready: Promise<void>; stop?: Unwatch } = {
    chatId: null,
    ready: Promise.resolve()
};

/**
 * Shows `chatId`'s messages (none for null), watching them; resolves once
 * the watch is registered, so nothing sent after is missed. The same chat
 * again keeps the watch it has.
 */
export function attach(chatId: string | null): Promise<void> {
    if (watching.chatId === chatId) return watching.ready;
    watching.stop?.();
    useChatStore.setState({ chatId, messages: [], loaded: chatId === null });
    const current: typeof watching = { chatId, ready: Promise.resolve() };
    watching = current;
    if (chatId) {
        current.ready = chatsApi
            .watchMessages(chatId, (update) => useChatStore.getState().apply(chatId, update))
            .then((stop) => {
                // Replaced meanwhile: this one's no longer wanted.
                if (watching === current) current.stop = stop;
                else stop();
            })
            .catch((error: unknown) => console.warn("[chat]", error));
    }
    return current.ready;
}

const warn = (title: string) => (error: unknown) =>
    toast.error({ title, description: error instanceof Error ? error.message : String(error) });

/**
 * Sends a prompt (and files) to the open chat; from the new-chat view, first
 * makes a chat in the folder picked for it and opens that. While the chat's
 * turn runs the prompt waits in its queue.
 */
export async function send(prompt: string, attachments: Attachment[] = []) {
    const text = prompt.trim();
    if (!text && attachments.length === 0) return;
    let chatId = useChatsStore.getState().activeChatId;
    if (!chatId) {
        const cwd = useChatsStore.getState().newChatCwd;
        if (!cwd) {
            toast.error({ title: "Choose a folder first", description: "Pick where the agent should work." });
            return;
        }
        try {
            chatId = (await chatsApi.create(cwd, newChatConfig())).id;
        } catch (error) {
            return warn("Couldn't start a chat")(error);
        }
        chats.select(chatId);
    }
    await attach(chatId);
    await chatsApi.send(chatId, text, attachments).catch(warn("Couldn't send"));
}

/** The open chat's id, for actions on it. */
const openChat = () => useChatsStore.getState().activeChatId;

/** Stops the open chat's running turn. */
export function stop() {
    const chatId = openChat();
    if (chatId) void chatsApi.interrupt(chatId);
}

/** Answers what the open chat's turn waits on. */
export function answer(requestId: string, response: InputResponse) {
    const chatId = openChat();
    if (chatId) void chatsApi.answer(chatId, requestId, response).catch(warn("Couldn't answer"));
}

/** The open chat's queue and background tasks. */
export const queue = {
    cancel: (id: string) => {
        const chatId = openChat();
        if (chatId) void chatsApi.cancelQueued(chatId, id).catch(warn("Couldn't remove it"));
    },
    sendNow: (id: string) => {
        const chatId = openChat();
        if (chatId) void chatsApi.sendQueuedNow(chatId, id).catch(warn("Couldn't send"));
    },
    reorder: (ids: string[]) => {
        const chatId = openChat();
        if (chatId) void chatsApi.reorderQueued(chatId, ids).catch(warn("Couldn't reorder"));
    },
    stopTask: (taskId: string) => {
        const chatId = openChat();
        if (chatId) void chatsApi.stopTask(chatId, taskId).catch(warn("Couldn't stop it"));
    }
};

/** The open chat's turn is running. */
export const useChatBusy = () =>
    useChatsStore((s) => !!s.activeChatId && !!s.sessions[s.activeChatId]?.working);
