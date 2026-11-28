import { Channel } from "@tauri-apps/api/core";
import type {
    Attachment,
    Chat,
    ChatConfig,
    ChatsUpdate,
    HandoffMode,
    HarnessId,
    InputResponse,
    MessagesUpdate,
    NewWorktree,
    SlashCommand,
    WorktreeStep
} from "@/proto";
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
    /**
     * With `worktree`, the chat works in a worktree of its own (a new branch
     * in a folder of its own); `onProgress` hears each step of making it.
     * The dev stand-in makes one up.
     */
    create: (cwd: string, config: ChatConfig, worktree?: NewWorktree, onProgress?: (step: WorktreeStep) => void) => {
        if (!isTauri) {
            if (worktree) return dev.createInWorktree(cwd, config, worktree, onProgress);
            return Promise.resolve(dev.create(cwd, config));
        }
        const channel = new Channel<WorktreeStep>((step) => onProgress?.(step));
        return backend<Chat>("chat_create", { cwd, config, worktree: worktree ?? null, onProgress: channel });
    },

    /** What the chat runs on; its live run picks it up from the next prompt. */
    setConfig: (chatId: string, config: ChatConfig) =>
        backend<Chat>("chat_set_config", { chatId, config }, () => dev.update(chatId, { config })),

    /**
     * Hands the chat to the agent `config` runs on, in the chat itself or a
     * new one; resolves to the chat that continues. Its next prompt carries
     * a summary of what came before (prompts sent meanwhile wait for it).
     */
    handoff: (chatId: string, config: ChatConfig, mode: HandoffMode) =>
        backend<Chat>("chat_handoff", { chatId, config, mode }, () => dev.handoff(chatId, config, mode)),

    /**
     * Forks the chat at `messageId`: a new chat on the same agent, folder
     * and worktree, with the transcript up to that message copied in. Its
     * first prompt carries a summary of it, as a handoff's does.
     */
    fork: (chatId: string, messageId: string) =>
        backend<Chat>("chat_fork", { chatId, messageId }, () => dev.fork(chatId, messageId)),

    /** The reply streams to the chat's message watchers; while a turn runs it's queued. */
    send: (chatId: string, prompt: string, attachments: Attachment[] = []) =>
        backend<void>("chat_send", { chatId, prompt, attachments }, () =>
            dev.send(chatId, prompt, attachments)
        ),

    /** Stops the running turn; its reply ends as stopped, and the queue waits. */
    interrupt: (chatId: string) =>
        backend<void>("chat_interrupt", { chatId }, () => dev.interrupt(chatId)),

    /** Answers the question or approval the turn waits on. */
    answer: (chatId: string, requestId: string, response: InputResponse) =>
        backend<void>("chat_answer", { chatId, requestId, response }, () =>
            dev.answer(chatId, requestId, response)
        ),

    /** The user's answer to a secret card; null declines. Goes to a private file, never the chat. */
    answerSecret: (id: string, value: string | null) =>
        backend<void>("secret_answer", { id, value }, () => undefined),

    stopTask: (chatId: string, taskId: string) =>
        backend<void>("chat_stop_task", { chatId, taskId }, () => dev.stopTask(chatId, taskId)),

    cancelQueued: (chatId: string, id: string) =>
        backend<void>("chat_queue_cancel", { chatId, id }, () => dev.cancelQueued(chatId, id)),

    /** Stops the running turn and sends the queued prompt next. */
    sendQueuedNow: (chatId: string, id: string) =>
        backend<void>("chat_queue_send_now", { chatId, id }, () => dev.sendQueuedNow(chatId, id)),

    reorderQueued: (chatId: string, ids: string[]) =>
        backend<void>("chat_queue_reorder", { chatId, ids }, () => dev.reorderQueued(chatId, ids)),

    /** `harness`'s commands and skills in `cwd`, before a chat's run lists its own. */
    commands: (harness: HarnessId, cwd: string) =>
        backend<SlashCommand[]>("harness_commands", { harness, cwd }, () => dev.commands()),

    /** Keeps a copy of a file to send; `data` is its base64. */
    saveAttachment: (name: string, data: string) =>
        backend<Attachment>("attachment_save", { name, data }, () => dev.saveAttachment(name, data)),

    /** Keeps a copy of a file on disk to send. */
    addAttachment: (path: string) => backend<Attachment>("attachment_add", { path }),

    /** An attachment as a `data:` URL, for previews. */
    attachmentUrl: (path: string, mimeType: string) =>
        backend<string>(
            "attachment_data_url",
            { path, mimeType },
            () => dev.attachmentUrl(path)
        ),

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
