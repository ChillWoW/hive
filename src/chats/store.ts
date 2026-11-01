import { useEffect, useMemo } from "react";
import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import type {
    Attachment,
    Chat,
    ChatConfig,
    ChatsUpdate,
    Command,
    Message,
    MessagesUpdate,
    Session,
    SessionStatus,
    UserInputAnswer
} from "@/proto";
import { errorMessage } from "@/lib/errors";
import { baseName } from "@/lib/paths";
import { useSettingsStore } from "@/settings/store";
import { foldEvent, stampEvent } from "@/transcript/fold";
import { chatsApi, type Unwatch } from "./api";
import { setups } from "./setups";

/**
 * Chats on the frontend: the list (with live sessions) from one app-wide
 * watch, and per-chat transcripts from watches held while something shows
 * them. Prompts go into an outbox and render right away; each leaves it when
 * the backend saves its user message (same id, minted here), or stays with an
 * error if its command is rejected.
 */

/** A prompt shown before the backend saves it as a user message. */
type Outgoing = {
    messageId: string;
    /** Null until a new chat's `create_chat` returns. */
    chatId: string | null;
    prompt: string;
    attachments: Attachment[];
    createdAt: number;
    commandId?: string;
    /** Waiting behind the running turn. */
    queued: boolean;
    error?: string;
};

type Transcript = {
    /** Saved messages, oldest first, with live events folded in. */
    messages: Message[];
    /** The first snapshot arrived (or the watch failed). */
    loaded: boolean;
    error?: string;
};

/** Where a prompt goes: an existing chat, or a new one created first. */
type SendTarget =
    | { chatId: string }
    | {
          cwd: string;
          config: ChatConfig;
          /** Give the chat a worktree; its branch is named after the prompt. */
          worktree?: { base: string | null };
      };

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
     * The subagent thread shown in the active chat: spawn ids from the
     * outermost in, a nested one deeper; empty is the chat itself.
     */
    subagent: string[];

    /**
     * Where Back and Forward go, nearest last, as in a browser. `select` and
     * the subagent moves push the place they leave onto `back`.
     */
    back: Place[];
    forward: Place[];

    /** Opens a chat (null: the new-chat view); the open one stays as it is. */
    select: (chatId: string | null) => void;
    /** Shows a spawn's thread; one opened inside another's goes a level deeper. */
    openSubagent: (chatId: string, id: string) => void;
    /** Up a level: to the parent subagent, else the chat. */
    openParent: () => void;
    goBack: () => void;
    goForward: () => void;
    /** Shows the prompt now; creates the chat first for a new-chat target. */
    send: (target: SendTarget, prompt: string, attachments?: Attachment[]) => Promise<void>;
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

/** A stop in Back/Forward history: a chat (null: the new-chat view) and the subagent shown in it. */
type Place = { chatId: string | null; subagent: string[] };

function samePlace(a: Place, b: Place) {
    return (
        a.chatId === b.chatId &&
        a.subagent.length === b.subagent.length &&
        a.subagent.every((id, i) => id === b.subagent[i])
    );
}

function here(s: Draft): Place {
    return { chatId: s.activeChatId, subagent: [...s.subagent] };
}

const NOT_SENT = "This message wasn't sent.";

/** When the chat last had activity: its latest turn, else its creation. */
export function activity(chat: Chat) {
    return chat.lastMessageAt ?? chat.createdAt;
}

/** Where the chat's agent works: its worktree, else its folder (`Chat::work_dir`). */
export function workDir(chat: Chat) {
    return chat.worktree?.path ?? chat.cwd;
}

/** The chat's title, else its folder's name. */
export function chatTitle(chat: Chat) {
    return chat.title ?? baseName(chat.cwd);
}

/** A turn is running, or waiting on the user mid-turn. */
export function isBusy(status: SessionStatus | undefined) {
    return status === "working" || status === "awaitingInput";
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
    if (s.activeChatId === chatId) {
        s.activeChatId = null;
        s.subagent = [];
    }
    s.back = tidyHistory(s.back, chatId, here(s));
    s.forward = tidyHistory(s.forward, chatId, here(s));
}

/** Enough to walk back through a session, small enough not to matter. */
const HISTORY_LIMIT = 100;

/** Leaves the place shown for `to`, remembering it for Back. */
function navigate(s: Draft, to: Place) {
    if (samePlace(here(s), to)) return;
    s.back.push(here(s));
    if (s.back.length > HISTORY_LIMIT) s.back.shift();
    s.forward = [];
    s.activeChatId = to.chatId;
    s.subagent = to.subagent;
}

/** Moves one entry from `from` to `to`, skipping chats that are gone. */
function step(s: Draft, from: Place[], to: Place[]) {
    while (from.length > 0) {
        const place = from.pop()!;
        if (samePlace(place, here(s))) continue;
        if (place.chatId !== null && !s.chats.some((c) => c.id === place.chatId)) continue;
        to.push(here(s));
        s.activeChatId = place.chatId;
        s.subagent = place.subagent;
        return;
    }
}

/** A history stack without `removed`'s places, repeats, or the place it leads from. */
function tidyHistory(stack: Place[], removed: string, current: Place) {
    const out: Place[] = [];
    for (const place of stack) {
        if (place.chatId === removed) continue;
        const last = out[out.length - 1];
        if (last && samePlace(last, place)) continue;
        out.push(place);
    }
    while (out.length > 0 && samePlace(out[out.length - 1], current)) out.pop();
    return out;
}

/** Chats being marked seen, so a re-render doesn't ask twice. */
const marking = new Set<string>();

function upsertChat(s: Draft, chat: Chat) {
    const i = s.chats.findIndex((c) => c.id === chat.id);
    if (i >= 0) s.chats[i] = chat;
    else s.chats.push(chat);
    sortChats(s);
}

/** Most recently active first, as the backend orders them. */
function sortChats(s: Draft) {
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
        attachments: command.payload.attachments ?? [],
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

export const useChatsStore = create<ChatsState>()(
    immer((set) => ({
        chats: [],
        sessions: {},
        loaded: false,

        activeChatId: null,
        transcripts: {},
        outbox: [],

        subagent: [],
        back: [],
        forward: [],

        select: (chatId) =>
            set((s) => {
                if (s.activeChatId !== chatId) navigate(s, { chatId, subagent: [] });
            }),
        openSubagent: (chatId, id) =>
            set((s) => {
                // Deeper from the thread shown; back up to `id` if it's already on the path.
                const at = s.activeChatId === chatId ? s.subagent.indexOf(id) : -1;
                const subagent =
                    s.activeChatId !== chatId
                        ? [id]
                        : at >= 0
                          ? s.subagent.slice(0, at + 1)
                          : [...s.subagent, id];
                navigate(s, { chatId, subagent });
            }),
        openParent: () =>
            set((s) => {
                if (s.subagent.length === 0) return;
                navigate(s, { chatId: s.activeChatId, subagent: s.subagent.slice(0, -1) });
            }),
        goBack: () => set((s) => step(s, s.back, s.forward)),
        goForward: () => set((s) => step(s, s.forward, s.back)),

        send: async (target, prompt, attachments = []) => {
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
                    attachments,
                    createdAt: Date.now(),
                    queued: false
                });
            });

            try {
                let chatId: string;
                if ("chatId" in target) {
                    chatId = target.chatId;
                } else {
                    const worktree = target.worktree && {
                        base: target.worktree.base ?? undefined,
                        // A files-only prompt names the branch after its files.
                        hint: prompt || attachments.map((a) => a.name).join(" ")
                    };
                    if (worktree) {
                        const naming =
                            useSettingsStore.getState().settings.worktrees.branchNaming ===
                            "semantic";
                        setups.begin(messageId, naming);
                    }
                    const chat = await chatsApi
                        .create(target.cwd, target.config, worktree, (step) =>
                            setups.step(messageId, step)
                        )
                        .catch((error: unknown) => {
                            setups.failed(messageId, errorMessage(error, NOT_SENT));
                            throw error;
                        });
                    chatId = chat.id;
                    if (worktree) setups.created(messageId, chat.id, chat.worktree);
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
                    messageId,
                    ...(attachments.length > 0 && { attachments })
                });
                edit((o) => track(o, command, true));
                if (command.status === "rejected" || command.status === "expired") {
                    setups.failed(messageId, command.resolution ?? NOT_SENT);
                }
            } catch (error) {
                setups.failed(messageId, errorMessage(error, NOT_SENT));
                edit((o) => {
                    o.error = errorMessage(error, NOT_SENT);
                });
            }
        },

        discard: (messageId) => {
            const o = useChatsStore.getState().outbox.find((o) => o.messageId === messageId);
            if (!o?.error) return;
            set((s) => removeOutgoing(s, messageId));
            setups.drop(messageId);
        },

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

        updateConfig: (chatId, config) =>
            editChat(chatId, { config }, () => chatsApi.updateConfig(chatId, config)),

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
        sortChats(s);
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
                if (key in before && chat[key] === patch[key]) {
                    (chat as Record<string, unknown>)[key] = before[key];
                }
            }
        });
        throw error;
    }
}

/** The open chat, kept across a page reload (not a restart). */
const ACTIVE_KEY = "hive.activeChat";

function readActive(): string | null {
    try {
        return sessionStorage.getItem(ACTIVE_KEY);
    } catch {
        return null;
    }
}

/** The chat open before a reload, reopened by the first snapshot. */
let restoring = readActive();

useChatsStore.subscribe((s, prev) => {
    if (s.activeChatId === prev.activeChatId) return;
    try {
        if (s.activeChatId) sessionStorage.setItem(ACTIVE_KEY, s.activeChatId);
        else sessionStorage.removeItem(ACTIVE_KEY);
    } catch {
        // Not kept, then.
    }
});

function applyChats(update: ChatsUpdate) {
    set((s) => {
        switch (update.type) {
            case "snapshot": {
                s.chats = update.chats;
                s.sessions = Object.fromEntries(
                    update.sessions.map((session) => [session.chatId, session])
                );
                s.loaded = true;
                // Unless the user already went elsewhere.
                const id = restoring;
                restoring = null;
                if (id && s.activeChatId === null && s.chats.some((c) => c.id === id)) {
                    s.activeChatId = id;
                }
                return;
            }
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
                if (m) {
                    foldEvent(m.parts, update.event);
                    stampEvent(m.parts, update.event, update.at);
                }
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
    if (update.type !== "queue" && update.type !== "command") {
        const messages = useChatsStore.getState().transcripts[chatId]?.messages;
        if (messages) setups.observe(chatId, messages);
    }
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
function retainMessages(chatId: string): () => void {
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
                        t.error = errorMessage(error, NOT_SENT);
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
type Delivery =
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
        attachments: o.attachments,
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

type Actions<T> = {
    [K in keyof T as T[K] extends (...args: never[]) => unknown ? K : never]: T[K];
};

/** A store's actions: they never change (`set` only touches state), so they're taken once. */
function actionsOf<T extends object>(state: T): Actions<T> {
    return Object.fromEntries(
        Object.entries(state).filter(([, value]) => typeof value === "function")
    ) as Actions<T>;
}

/** Same actions outside React. */
export const chats = {
    ...actionsOf(useChatsStore.getState()),
    /** Background tasks live on the session; nothing here to update. */
    stopTask: chatsApi.stopTask,
    taskOutput: chatsApi.taskOutput,
    /** The card goes when the session drops it (`Session.secrets`). */
    answerSecret: chatsApi.answerSecret
};

export function useChat(chatId: string | null) {
    return useChatsStore((s) =>
        chatId ? s.chats.find((c) => c.id === chatId) : undefined
    );
}
