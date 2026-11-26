import { create } from "zustand";
import type { Attachment, InputResponse, Message, MessagesUpdate } from "@/proto";
import { chatsApi, type Unwatch } from "@/features/chats/api";
import { chats, useChatsStore } from "@/features/chats/store";
import { useComposerStore } from "@/features/composer/store";
import { git } from "@/features/git/store";
import { settings } from "@/features/settings";
import { toast } from "@/ui";
import { newChatConfig } from "./config";
import { foldEvent, stampEvent } from "./fold";
import { setups, useSetups } from "./setup";

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

/** Whether a new chat in `cwd` gets a worktree: picked, and `cwd` is a checkout with a commit. */
function wantsWorktree(cwd: string) {
    if (useComposerStore.getState().newChatWorkspace !== "worktree") return false;
    return !!git.known(cwd)?.commit;
}

/**
 * Makes the new-chat view's chat in `cwd`, in a worktree when one is
 * picked; its setup card follows along (`./setup.ts`).
 */
async function createChat(cwd: string, prompt: string, attachments: Attachment[]) {
    setups.dismiss();
    if (!wantsWorktree(cwd)) return chatsApi.create(cwd, newChatConfig());
    const base = useComposerStore.getState().newChatBase ?? undefined;
    setups.begin(prompt, attachments, settings.get().worktrees.branchNaming === "semantic");
    // A files-only prompt names the branch after its files.
    const hint = prompt || attachments.map((a) => a.name).join(" ");
    try {
        const chat = await chatsApi.create(cwd, newChatConfig(), { base, hint }, setups.step);
        setups.created(chat);
        useComposerStore.getState().setNewChatBase(null);
        return chat;
    } catch (error) {
        setups.failed(error instanceof Error ? error.message : String(error));
        throw error;
    } finally {
        // The branch it took is in use now.
        void git.refresh(cwd, true);
    }
}

/**
 * Sends a prompt (and files) to the open chat; from the new-chat view, first
 * makes a chat in the folder picked for it (in a worktree of its own, when
 * picked) and opens that. While the chat's turn runs the prompt waits in
 * its queue.
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
        // One chat at a time.
        const draft = useSetups.getState().draft;
        if (draft && !draft.error) return;
        try {
            chatId = (await createChat(cwd, text, attachments)).id;
        } catch (error) {
            // The prompt goes back in the box, unless something new is there.
            const draft = useComposerStore.getState();
            if (!draft.drafts.new && !draft.attachments.new?.length) {
                draft.setDraft(null, prompt);
                draft.setAttachments(null, attachments);
            }
            // A worktree's setup card says why.
            if (useSetups.getState().draft?.error) return;
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

// A worktree chat's setup ends once its agent answers.
useChatStore.subscribe((s) => {
    if (s.chatId) setups.observe(s.chatId, s.messages);
});
