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

    /**
     * Where Back and Forward go, nearest last, as in a browser; null is the
     * new-chat view. `select` pushes the chat it leaves onto `back`.
     */
    back: (string | null)[];
    forward: (string | null)[];

    select: (chatId: string | null) => void;
    goBack: () => void;
    goForward: () => void;
    /** Shows the prompt now; creates the chat first for a new-chat target. */
    send: (target: SendTarget, prompt: string) => Promise<void>;
    /** Drops a failed prompt from the outbox. */
    discard: (messageId: string) => void;
    /** Withdraws a queued prompt; gone at once, back if that's refused. */
    cancelQueued: (messageId: string) => Promise<boolean>;
    /** Puts a chat's queued prompts in this order, next first. */
    reorderQueued: (chatId: string, messageIds: string[]) => Promise<void>;
    /** Runs a queued prompt next, stopping the running turn if there is one. */
    sendNow: (messageId: string) => Promise<void>;
    /** Saves a chat's run settings; shown at once, reverted if refused. */
    updateConfig: (chatId: string, config: ChatConfig) => Promise<void>;
    /** Shown at once, reverted if refused; a blank title clears it. */
    rename: (chatId: string, title: string | null) => Promise<void>;
    /** Archiving also unpins. */
    setArchived: (chatId: string, archived: boolean) => Promise<void>;
    /** Pinning also unarchives. */
    setPinned: (chatId: string, pinned: boolean) => Promise<void>;
    /** Clears the chat's unread dot. */
    markSeen: (chatId: string) => Promise<void>;
    /** Gone from the list at once; back if the engine refuses. */
    remove: (chatId: string) => Promise<void>;
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

/** When the chat last had activity: its latest turn, else its creation. */
export function activity(chat: Chat) {
    return chat.lastMessageAt ?? chat.createdAt;
}

/** The chat has activity the user hasn't opened yet (`Chat::unseen`). */
export function isUnseen(chat: Chat) {
    if (chat.lastMessageAt == null) return false;
    return chat.lastSeenAt == null || chat.lastMessageAt > chat.lastSeenAt;
}

/** Drops a chat and everything kept for it. */
function dropChat(s: Draft, chatId: string) {
    s.chats = s.chats.filter((c) => c.id !== chatId);
    delete s.sessions[chatId];
    delete s.transcripts[chatId];
    s.outbox = s.outbox.filter((o) => o.chatId !== chatId);
    if (s.activeChatId === chatId) s.activeChatId = null;
    s.back = tidyHistory(s.back, chatId, s.activeChatId);
    s.forward = tidyHistory(s.forward, chatId, s.activeChatId);
}

/** Enough to walk back through a session, small enough not to matter. */
const HISTORY_LIMIT = 100;

/** Leaves the active chat for `chatId`, remembering it for Back. */
function navigate(s: Draft, chatId: string | null) {
    if (s.activeChatId === chatId) return;
    s.back.push(s.activeChatId);
    if (s.back.length > HISTORY_LIMIT) s.back.shift();
    s.forward = [];
    s.activeChatId = chatId;
}

/** Moves one entry from `from` to `to`, skipping chats that are gone. */
function step(s: Draft, from: (string | null)[], to: (string | null)[]) {
    while (from.length > 0) {
        const chatId = from.pop()!;
        if (chatId === s.activeChatId) continue;
        if (chatId !== null && !s.chats.some((c) => c.id === chatId)) continue;
        to.push(s.activeChatId);
        s.activeChatId = chatId;
        return;
    }
}

/** A history stack without `removed`, repeats, or the chat it leads from. */
function tidyHistory(
    stack: (string | null)[],
    removed: string,
    current: string | null
) {
    const out: (string | null)[] = [];
    for (const chatId of stack) {
        if (chatId === removed || chatId === out[out.length - 1]) continue;
        out.push(chatId);
    }
    while (out.length > 0 && out[out.length - 1] === current) out.pop();
    return out;
}

/** Chats being marked seen, so a re-render doesn't ask twice. */
const marking = new Set<string>();

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

/**
 * Puts a chat's outbox entries for `commandIds` in that order, within the
 * slots they already hold; other entries stay put.
 */
function orderOutbox(s: Draft, chatId: string, commandIds: string[]) {
    const rank = new Map(commandIds.map((id, i) => [id, i]));
    const slots: number[] = [];
    const entries: Outgoing[] = [];
    s.outbox.forEach((o, i) => {
        if (o.chatId === chatId && o.commandId && rank.has(o.commandId)) {
            slots.push(i);
            entries.push(o);
        }
    });
    entries.sort((a, b) => rank.get(a.commandId!)! - rank.get(b.commandId!)!);
    slots.forEach((slot, j) => {
        s.outbox[slot] = entries[j];
    });
}

/** A chat's queued prompts' command ids, next first. */
function queuedIds(outbox: Outgoing[], chatId: string) {
    return outbox.flatMap((o) =>
        o.chatId === chatId && o.queued && o.commandId ? [o.commandId] : []
    );
}

/** A queued prompt that can still be withdrawn, reordered or sent now. */
function findQueued(messageId: string) {
    const o = useChatsStore.getState().outbox.find((o) => o.messageId === messageId);
    if (!o?.chatId || !o.commandId || !o.queued || o.error) return undefined;
    return { ...o, chatId: o.chatId, commandId: o.commandId };
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

        back: [],
        forward: [],

        select: (chatId) => set((s) => navigate(s, chatId)),
        goBack: () => set((s) => step(s, s.back, s.forward)),
        goForward: () => set((s) => step(s, s.forward, s.back)),

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
                        // The chat takes the new-chat view's place in history.
                        if (s.activeChatId === null) {
                            s.activeChatId = chat.id;
                            s.forward = [];
                        }
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

        cancelQueued: async (messageId) => {
            const o = findQueued(messageId);
            if (!o) return false;
            const at = useChatsStore
                .getState()
                .outbox.findIndex((x) => x.messageId === messageId);
            set((s) => removeOutgoing(s, messageId));
            try {
                await chatsApi.cancelQueued(o.chatId, o.commandId);
                return true;
            } catch (error) {
                console.warn(`[chats] withdrawing ${messageId} failed`, error);
                set((s) => {
                    // Unless it ran meanwhile.
                    const saved = s.transcripts[o.chatId]?.messages.some(
                        (m) => m.id === messageId
                    );
                    if (saved || s.outbox.some((x) => x.messageId === messageId)) return;
                    s.outbox.splice(Math.min(at, s.outbox.length), 0, o);
                });
                throw error;
            }
        },

        reorderQueued: async (chatId, messageIds) => {
            const { outbox } = useChatsStore.getState();
            const before = queuedIds(outbox, chatId);
            const commandIds = messageIds.flatMap((id) => {
                const o = outbox.find((o) => o.messageId === id);
                return o?.commandId ? [o.commandId] : [];
            });
            set((s) => orderOutbox(s, chatId, commandIds));
            try {
                await chatsApi.reorderQueue(chatId, commandIds);
            } catch (error) {
                console.warn(`[chats] reordering ${chatId}'s queue failed`, error);
                set((s) => orderOutbox(s, chatId, before));
                throw error;
            }
        },

        sendNow: async (messageId) => {
            const o = findQueued(messageId);
            if (!o) return;
            // Out of the tray and into the transcript, as it's sending.
            set((s) => {
                const sent = s.outbox.find((x) => x.messageId === messageId);
                if (sent) sent.queued = false;
            });
            try {
                await chatsApi.sendQueuedNow(o.chatId, o.commandId);
            } catch (error) {
                console.warn(`[chats] sending ${messageId} now failed`, error);
                set((s) => {
                    const sent = s.outbox.find((x) => x.messageId === messageId);
                    if (sent && !sent.error) sent.queued = true;
                });
                throw error;
            }
        },

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

        rename: (chatId, title) => {
            const trimmed = title?.trim() || undefined;
            return editChat(chatId, { title: trimmed }, () =>
                chatsApi.rename(chatId, trimmed ?? null)
            );
        },

        setArchived: (chatId, archived) =>
            editChat(
                chatId,
                archived ? { archived, pinnedAt: undefined } : { archived },
                () => chatsApi.setArchived(chatId, archived)
            ),

        setPinned: (chatId, pinned) => {
            const chat = useChatsStore.getState().chats.find((c) => c.id === chatId);
            const patch: Partial<Chat> = pinned
                ? { pinnedAt: chat?.pinnedAt ?? Date.now(), archived: false }
                : { pinnedAt: undefined };
            return editChat(chatId, patch, () => chatsApi.setPinned(chatId, pinned));
        },

        markSeen: async (chatId) => {
            const chat = useChatsStore.getState().chats.find((c) => c.id === chatId);
            if (!chat || !isUnseen(chat) || marking.has(chatId)) return;
            marking.add(chatId);
            try {
                await editChat(
                    chatId,
                    { lastSeenAt: Math.max(Date.now(), chat.lastMessageAt ?? 0) },
                    () => chatsApi.markSeen(chatId)
                );
            } finally {
                marking.delete(chatId);
            }
        },

        remove: async (chatId) => {
            const state = useChatsStore.getState();
            const chat = state.chats.find((c) => c.id === chatId);
            if (!chat) return;
            const wasActive = state.activeChatId === chatId;
            set((s) => dropChat(s, chatId));
            try {
                await chatsApi.remove(chatId);
            } catch (error) {
                console.warn(`[chats] deleting ${chatId} failed`, error);
                set((s) => {
                    if (s.chats.some((c) => c.id === chatId)) return;
                    upsertChat(s, chat);
                    if (wasActive && s.activeChatId === null) s.activeChatId = chatId;
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

/**
 * Shows `patch` on the chat at once and saves it with `request`; if that's
 * refused, puts back whichever fields nothing has changed again meanwhile.
 */
async function editChat(
    chatId: string,
    patch: Partial<Chat>,
    request: () => Promise<Chat>
): Promise<void> {
    const keys = Object.keys(patch) as (keyof Chat)[];
    const before: Partial<Chat> = {};
    set((s) => {
        const chat = s.chats.find((c) => c.id === chatId);
        if (!chat) return;
        for (const key of keys) (before as Record<string, unknown>)[key] = chat[key];
        Object.assign(chat, patch);
        s.chats.sort((a, b) => activity(b) - activity(a));
    });
    try {
        const chat = await request();
        set((s) => upsertChat(s, chat));
    } catch (error) {
        console.warn(`[chats] updating ${chatId} failed`, error);
        set((s) => {
            const chat = s.chats.find((c) => c.id === chatId);
            if (!chat) return;
            for (const key of keys) {
                if (chat[key] === patch[key]) {
                    (chat as Record<string, unknown>)[key] = before[key];
                }
            }
        });
        throw error;
    }
}

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
            case "removed":
                dropChat(s, update.chatId);
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
                orderOutbox(
                    s,
                    chatId,
                    update.pending.map((c) => c.id)
                );
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
                if (command.status === "cancelled") {
                    removeOutgoing(s, id);
                    return;
                }
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

            case "queue":
                orderOutbox(s, chatId, update.commandIds);
                return;
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
    goBack: () => useChatsStore.getState().goBack(),
    goForward: () => useChatsStore.getState().goForward(),
    send: (target: SendTarget, prompt: string) =>
        useChatsStore.getState().send(target, prompt),
    discard: (messageId: string) => useChatsStore.getState().discard(messageId),
    cancelQueued: (messageId: string) =>
        useChatsStore.getState().cancelQueued(messageId),
    reorderQueued: (chatId: string, messageIds: string[]) =>
        useChatsStore.getState().reorderQueued(chatId, messageIds),
    sendNow: (messageId: string) => useChatsStore.getState().sendNow(messageId),
    updateConfig: (chatId: string, config: ChatConfig) =>
        useChatsStore.getState().updateConfig(chatId, config),
    rename: (chatId: string, title: string | null) =>
        useChatsStore.getState().rename(chatId, title),
    setArchived: (chatId: string, archived: boolean) =>
        useChatsStore.getState().setArchived(chatId, archived),
    setPinned: (chatId: string, pinned: boolean) =>
        useChatsStore.getState().setPinned(chatId, pinned),
    markSeen: (chatId: string) => useChatsStore.getState().markSeen(chatId),
    remove: (chatId: string) => useChatsStore.getState().remove(chatId),
    interrupt: (chatId: string) => useChatsStore.getState().interrupt(chatId),
    answer: (chatId: string, requestId: string, answers: UserInputAnswer[]) =>
        useChatsStore.getState().answer(chatId, requestId, answers)
};

export function useChat(chatId: string | null) {
    return useChatsStore((s) =>
        chatId ? s.chats.find((c) => c.id === chatId) : undefined
    );
}
