import { Channel } from "@tauri-apps/api/core";
import type { Chat, ChatsUpdate, MessagesUpdate } from "@/proto";
import { backend } from "@/lib/backend";
import { isTauri } from "@/lib/platform";
import { dev } from "./dev";

/** Stops a watcher. */
export type Unwatch = () => void;

/**
 * Watches over a Tauri channel: `command` registers it (the first update, a
 * snapshot, is already on its way when it resolves) and `chat_unwatch` ends it.
 */
async function watch<T>(
    command: string,
    args: Record<string, unknown>,
    onUpdate: (update: T) => void,
    devWatch: (onUpdate: (update: T) => void) => Unwatch
): Promise<Unwatch> {
    // Its own sink even when `onUpdate` is one already watching.
    if (!isTauri) return devWatch((update) => onUpdate(update));
    let live = true;
    const channel = new Channel<T>((update) => {
        if (live) onUpdate(update);
    });
    const id = await backend<number>(command, { ...args, onUpdate: channel });
    return () => {
        live = false;
        void backend("chat_unwatch", { id }).catch(() => {});
    };
}

/**
 * The one way the UI talks to chats; components never call `backend()` for
 * them. Under `bun run dev` an in-memory stand-in (`dev.ts`) answers, its
 * turns scripted.
 */
export const chatsApi = {
    create: (cwd: string) => backend<Chat>("chat_create", { cwd }, () => dev.create(cwd)),

    /** The reply streams to the chat's message watchers. */
    send: (chatId: string, prompt: string) =>
        backend<void>("chat_send", { chatId, prompt }, () => dev.send(chatId, prompt)),

    /** Stops the running turn; its reply ends as stopped. */
    interrupt: (chatId: string) =>
        backend<void>("chat_interrupt", { chatId }, () => dev.interrupt(chatId)),

    /** A blank title clears it. */
    rename: (chatId: string, title: string | null) =>
        backend<Chat>("chat_rename", { chatId, title }, () =>
            dev.update(chatId, { title: title?.trim() || undefined })
        ),

    setPinned: (chatId: string, pinned: boolean) =>
        backend<Chat>("chat_set_pinned", { chatId, pinned }, () =>
            dev.update(chatId, { pinnedAt: pinned ? Date.now() : undefined })
        ),

    /** Archiving unpins. */
    setArchived: (chatId: string, archived: boolean) =>
        backend<Chat>("chat_set_archived", { chatId, archived }, () =>
            dev.update(chatId, archived ? { archived, pinnedAt: undefined } : { archived })
        ),

    /** Deletes the chat and its transcript, stopping its agent. */
    remove: (chatId: string) =>
        backend<void>("chat_delete", { chatId }, () => dev.remove(chatId)),

    /** Every chat, then each change. */
    watchChats: (onUpdate: (update: ChatsUpdate) => void) =>
        watch("chat_watch", {}, onUpdate, dev.watchChats),

    /** A chat's messages, then each change. */
    watchMessages: (chatId: string, onUpdate: (update: MessagesUpdate) => void) =>
        watch("chat_watch_messages", { chatId }, onUpdate, (sink) =>
            dev.watchMessages(chatId, sink)
        ),

    /** A folder's favicon or app icon as a data URL; null when it has none. */
    folderIcon: (path: string) =>
        backend<string | null>("folder_icon", { path }, () => null)
};
