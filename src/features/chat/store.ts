import { create } from "zustand";
import type { Message, MessagesUpdate } from "@/proto";
import { chatsApi, type Unwatch } from "@/features/chats/api";
import { chats, useChatsStore } from "@/features/chats/store";
import { toast } from "@/ui";
import { newChatConfig } from "./config";
import { foldEvent } from "./fold";

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
                        m.id === update.messageId ? { ...m, parts: foldEvent(m.parts, update.event) } : m
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
 * Sends a prompt to the open chat; from the new-chat view, first makes a
 * chat in the folder picked for it and opens that.
 */
export async function send(prompt: string) {
    const text = prompt.trim();
    if (!text) return;
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
    await chatsApi.send(chatId, text).catch(warn("Couldn't send"));
}

/** Stops the open chat's running turn. */
export function stop() {
    const chatId = useChatsStore.getState().activeChatId;
    if (chatId) void chatsApi.interrupt(chatId);
}

/** The open chat's turn is running: its last reply is still streaming. */
export const useChatBusy = () =>
    useChatStore((s) => s.messages.at(-1)?.status === "streaming");
