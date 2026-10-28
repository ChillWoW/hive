import { useEffect, useMemo } from "react";
import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import type {
    Chat,
    ChatConfig,
    ChatsUpdate,
    Command,
    Message,
    MessagesUpdate,
    Session,
    UserInputAnswer
} from "@/proto";
import { foldEvent } from "@/transcript/fold";
import { chatsApi, type Unwatch } from "./api";

/**
 * Chats on the frontend: the list (with live sessions) from one app-wide
 * watch, and per-chat transcripts from watches held while something shows
 * them. Prompts go into an outbox and render right away; each leaves it when
 * the backend saves its user message (same id, minted here), or stays with an
 * error if its command is rejected.
 */

/** A prompt shown before the backend saves it as a user message. */
export type Outgoing = {
    messageId: string;
    /** Null until a new chat's `create_chat` returns. */
    chatId: string | null;
    prompt: string;
    createdAt: number;
    commandId?: string;
    /** Waiting behind the running turn. */
    queued: boolean;
    error?: string;
};

export type Transcript = {
    /** Saved messages, oldest first, with live events folded in. */
    messages: Message[];
    /** The first snapshot arrived (or the watch failed). */
    loaded: boolean;
    error?: string;
};

/** Where a prompt goes: an existing chat, or a new one created first. */
export type SendTarget =
    | { chatId: string }
    | { cwd: string; config: ChatConfig };

type ChatsState = {
    /** Most recently active first, as the backend orders them. */
    chats: Chat[];
    /** Live sessions by chat id. */
    sessions: Record<string, Session>;
    loaded: boolean;

    /** Null is the new-chat view; its outbox entries have no chat yet. */
    activeChatId: string | null;
    transcripts: Record<string, Transcript>;
    outbox: Outgoing[];

    select: (chatId: string | null) => void;
    /** Shows the prompt now; creates the chat first for a new-chat target. */
    send: (target: SendTarget, prompt: string) => Promise<void>;
    /** Drops a failed prompt from the outbox. */
    discard: (messageId: string) => void;
    /** Saves a chat's run settings; shown at once, reverted if refused. */
    updateConfig: (chatId: string, config: ChatConfig) => Promise<void>;
    /** Stops the running turn. */
    interrupt: (chatId: string) => Promise<void>;
    /** Answers an agent's question; the wizard closes when it resolves. */
    answer: (
        chatId: string,
        requestId: string,
        answers: UserInputAnswer[]
    ) => Promise<void>;
};

type Draft = ChatsState;

const NOT_SENT = "This message wasn't sent.";

function activity(chat: Chat) {
    return chat.lastMessageAt ?? chat.createdAt;
}

function upsertChat(s: Draft, chat: Chat) {
    const i = s.chats.findIndex((c) => c.id === chat.id);
    if (i >= 0) s.chats[i] = chat;
    else s.chats.push(chat);
    s.chats.sort((a, b) => activity(b) - activity(a));
}

/** The user message id a send command carries. */
function sentId(command: Command) {
    return command.payload.kind === "send"
        ? command.payload.messageId
        : undefined;
}

/**
 * Applies what's known about a prompt's command. `queued` says a pending
 * status means waiting behind a turn; a watcher's pending update doesn't,
 * since every command is pending for a moment at issue.
 */
function track(o: Outgoing, command: Command, queued: boolean) {
    o.commandId = command.id;
    switch (command.status) {
        case "pending":
            if (queued) o.queued = true;
            return;
        case "applied":
            // Its user message arrives (or arrived) on the chat's watch.
            return;
        default:
            o.queued = false;
            o.error = command.resolution ?? NOT_SENT;
    }
}

function fromCommand(command: Command, queued: boolean): Outgoing | null {
    if (command.payload.kind !== "send") return null;
    const o: Outgoing = {
        messageId: command.payload.messageId,
        chatId: command.chatId,
        prompt: command.payload.prompt,
        createdAt: command.issuedAt,
        queued: false
    };
    track(o, command, queued);
    return o;
}

function removeOutgoing(s: Draft, messageId: string) {
    const i = s.outbox.findIndex((o) => o.messageId === messageId);
    if (i >= 0) s.outbox.splice(i, 1);
}

function errorText(error: unknown) {
    if (error instanceof Error) return error.message;
    return typeof error === "string" ? error : NOT_SENT;
}

export const useChatsStore = create<ChatsState>()(
    immer((set) => ({
        chats: [],
        sessions: {},
        loaded: false,

        activeChatId: null,
        transcripts: {},
        outbox: [],

        select: (chatId) => set({ activeChatId: chatId }),

        send: async (target, prompt) => {
            const messageId = crypto.randomUUID();
            const edit = (change: (o: Outgoing) => void) =>
                set((s) => {
                    const o = s.outbox.find((o) => o.messageId === messageId);
                    if (o) change(o);
                });

            set((s) => {
                s.outbox.push({
                    messageId,
                    chatId: "chatId" in target ? target.chatId : null,
                    prompt,
                    createdAt: Date.now(),
                    queued: false
                });
            });

            try {
                let chatId: string;
                if ("chatId" in target) {
                    chatId = target.chatId;
                } else {
                    const chat = await chatsApi.create(target.cwd, target.config);
                    chatId = chat.id;
                    // One update, so the prompt never drops out of view.
                    set((s) => {
                        upsertChat(s, chat);
                        const o = s.outbox.find((o) => o.messageId === messageId);
                        if (o) o.chatId = chat.id;
                        // Follow the prompt into its chat, unless the user
                        // already went elsewhere.
                        if (s.activeChatId === null) s.activeChatId = chat.id;
                    });
                }
                const command = await chatsApi.queueCommand(chatId, {
                    kind: "send",
                    prompt,
                    messageId
                });
                edit((o) => track(o, command, true));
            } catch (error) {
                edit((o) => {
                    o.error = errorText(error);
                });
            }
        },

        discard: (messageId) =>
            set((s) => {
                const o = s.outbox.find((o) => o.messageId === messageId);
                if (o?.error) removeOutgoing(s, messageId);
            }),

        updateConfig: async (chatId, config) => {
            let previous: ChatConfig | undefined;
            set((s) => {
                const chat = s.chats.find((c) => c.id === chatId);
                if (!chat) return;
                previous = chat.config;
                chat.config = config;
            });
            try {
                const chat = await chatsApi.updateConfig(chatId, config);
                set((s) => upsertChat(s, chat));
            } catch (error) {
                console.warn(`[chats] updating ${chatId}'s config failed`, error);
                set((s) => {
                    const chat = s.chats.find((c) => c.id === chatId);
                    // Only if nothing changed it again meanwhile.
                    if (chat && previous && chat.config === config) {
                        chat.config = previous;
                    }
                });
                throw error;
            }
        },

        interrupt: async (chatId) => {
            await settled(chatsApi.queueCommand(chatId, { kind: "interrupt" }));
        },

        answer: async (chatId, requestId, answers) => {
            await settled(
                chatsApi.queueCommand(chatId, {
                    kind: "answer",
                    requestId,
                    answers
                })
            );
        }
    }))
);

/** Rejects with the command's resolution when the engine refused it. */
async function settled(command: Promise<Command>): Promise<Command> {
    const c = await command;
    if (c.status === "rejected" || c.status === "expired") {
        throw new Error(c.resolution ?? "That didn't go through.");
    }
    return c;
}

const set = useChatsStore.setState;

function applyChats(update: ChatsUpdate) {
    set((s) => {
        switch (update.type) {
            case "snapshot":
                s.chats = update.chats;
                s.sessions = Object.fromEntries(
                    update.sessions.map((session) => [session.chatId, session])
                );
                s.loaded = true;
                return;
            case "chat":
                upsertChat(s, update.chat);
                return;
            case "session":
                if (update.session) s.sessions[update.chatId] = update.session;
                else delete s.sessions[update.chatId];
                return;
        }
    });
}

function applyMessages(chatId: string, update: MessagesUpdate) {
    set((s) => {
        const t = (s.transcripts[chatId] ??= { messages: [], loaded: false });

        switch (update.type) {
            case "snapshot": {
                t.messages = update.messages;
                t.loaded = true;
                t.error = undefined;

                const saved = new Set(update.messages.map((m) => m.id));
                const pending = new Map<string, Command>();
                for (const c of update.pending) {
                    const id = sentId(c);
                    if (id) pending.set(id, c);
                }
                s.outbox = s.outbox.filter(
                    (o) => o.chatId !== chatId || !saved.has(o.messageId)
                );
                for (const o of s.outbox) {
                    if (o.chatId !== chatId) continue;
                    const c = pending.get(o.messageId);
                    if (c) {
                        track(o, c, true);
                        pending.delete(o.messageId);
                    } else if (o.commandId && !o.error) {
                        // Settled while unwatched without becoming a message.
                        o.queued = false;
                        o.error = NOT_SENT;
                    }
                }
                // Queued from another window, or before a reload.
                for (const c of pending.values()) {
                    const o = fromCommand(c, true);
                    if (o) s.outbox.push(o);
                }
                return;
            }

            case "message": {
                const { message } = update;
                const i = t.messages.findIndex((m) => m.id === message.id);
                if (i >= 0) t.messages[i] = message;
                else t.messages.push(message);
                removeOutgoing(s, message.id);
                return;
            }

            case "event": {
                const m = t.messages.find((m) => m.id === update.messageId);
                if (m) foldEvent(m.parts, update.event);
                return;
            }

            case "command": {
                const { command } = update;
                const id = sentId(command);
                if (!id) return;
                const o = s.outbox.find((o) => o.messageId === id);
                if (o) {
                    track(o, command, false);
                } else if (
                    command.status === "pending" &&
                    !t.messages.some((m) => m.id === id)
                ) {
                    const sent = fromCommand(command, false);
                    if (sent) s.outbox.push(sent);
                }
                return;
            }
        }
    });
}

let chatsHydration: Promise<void> | null = null;

/** Starts the app-wide chat list watch; safe to call repeatedly. */
export function hydrateChats(): Promise<void> {
    chatsHydration ??= chatsApi.watchChats(applyChats).then(
        () => {},
        (error: unknown) => {
            // Let a later call retry.
            chatsHydration = null;
            console.warn("[chats] watch failed", error);
        }
    );
    return chatsHydration;
}

type MessagesWatch = { refs: number; stop: Promise<Unwatch | null> };

const watches = new Map<string, MessagesWatch>();

/**
 * Holds a chat's transcript watch open until the returned release. The
 * transcript stays cached after the last release; the next watch's snapshot
 * replaces it.
 */
export function retainMessages(chatId: string): () => void {
    let watch = watches.get(chatId);
    if (!watch) {
        const entry: MessagesWatch = { refs: 0, stop: Promise.resolve(null) };
        watches.set(chatId, entry);
        // A released watch's late updates are dropped.
        const live = () => watches.get(chatId) === entry;
        entry.stop = chatsApi
            .watchMessages(chatId, (update) => {
                if (live()) applyMessages(chatId, update);
            })
            .catch((error: unknown) => {
                console.warn(`[chats] watching ${chatId} failed`, error);
                if (live()) {
                    watches.delete(chatId);
                    set((s) => {
                        const t = (s.transcripts[chatId] ??= {
                            messages: [],
                            loaded: false
                        });
                        t.loaded = true;
                        t.error = errorText(error);
                    });
                }
                return null;
            });
        watch = entry;
    }

    const held = watch;
    held.refs++;
    let released = false;
    return () => {
        if (released) return;
        released = true;
        if (--held.refs > 0) return;
        if (watches.get(chatId) === held) watches.delete(chatId);
        void held.stop.then((stop) => stop?.());
    };
}

/** How far a shown prompt got; absent once the backend saved it. */
export type Delivery =
    | { state: "sending" }
    | { state: "queued" }
    | { state: "failed"; error: string };

export type TranscriptMessage = Message & { delivery?: Delivery };

function toMessage(o: Outgoing): TranscriptMessage {
    return {
        id: o.messageId,
        chatId: o.chatId ?? "",
        role: "user",
        parts: [{ kind: "text", id: "t0", text: o.prompt }],
        createdAt: o.createdAt,
        delivery: o.error
            ? { state: "failed", error: o.error }
            : { state: o.queued ? "queued" : "sending" }
    };
}

/**
 * A chat's transcript with its unconfirmed prompts after it; `null` is the
 * new-chat view. Keeps the chat's watch open while mounted.
 */
export function useChatMessages(chatId: string | null) {
    useEffect(() => (chatId ? retainMessages(chatId) : undefined), [chatId]);

    const transcript = useChatsStore((s) =>
        chatId ? s.transcripts[chatId] : undefined
    );
    const outbox = useChatsStore((s) => s.outbox);

    return useMemo(() => {
        const outgoing = outbox
            .filter((o) => o.chatId === chatId)
            .map(toMessage);
        const messages: TranscriptMessage[] = transcript
            ? [...transcript.messages, ...outgoing]
            : outgoing;
        return {
            messages,
            loading: chatId !== null && !transcript?.loaded,
            error: transcript?.error
        };
    }, [chatId, transcript, outbox]);
}

export function useSession(chatId: string | null) {
    return useChatsStore((s) => (chatId ? s.sessions[chatId] : undefined));
}

/** Same actions outside React. */
export const chats = {
    get: () => useChatsStore.getState(),
    select: (chatId: string | null) =>
        useChatsStore.getState().select(chatId),
    send: (target: SendTarget, prompt: string) =>
        useChatsStore.getState().send(target, prompt),
    discard: (messageId: string) => useChatsStore.getState().discard(messageId),
    updateConfig: (chatId: string, config: ChatConfig) =>
        useChatsStore.getState().updateConfig(chatId, config),
    interrupt: (chatId: string) => useChatsStore.getState().interrupt(chatId),
    answer: (chatId: string, requestId: string, answers: UserInputAnswer[]) =>
        useChatsStore.getState().answer(chatId, requestId, answers)
};

export function useChat(chatId: string | null) {
    return useChatsStore((s) =>
        chatId ? s.chats.find((c) => c.id === chatId) : undefined
    );
}
