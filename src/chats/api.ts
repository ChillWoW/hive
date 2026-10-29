import { Channel, invoke } from "@tauri-apps/api/core";
import type {
    Chat,
    ChatConfig,
    ChatsUpdate,
    Command,
    CommandPayload,
    MessagesUpdate,
    NewWorktree,
    TaskOutput
} from "@/proto";
import { isTauri } from "@/lib/platform";

/**
 * Transport for chats (`src-tauri/src/engine.rs`). Under a plain `bun run dev`
 * there's no engine: watches report an empty snapshot and writes reject, so
 * the UI renders and a send shows as failed.
 */

const NO_BACKEND = "Chats need the Hive app; there's no engine under `bun run dev`.";

/** Stops a watch; safe to call more than once. */
export type Unwatch = () => void;

function watch<T>(
    command: string,
    args: Record<string, unknown>,
    onUpdate: (update: T) => void
): Promise<Unwatch> {
    const channel = new Channel<T>();
    let open = true;
    channel.onmessage = (update) => {
        if (open) onUpdate(update);
    };
    return invoke<number>(command, { ...args, onUpdate: channel }).then(
        (id) => () => {
            if (!open) return;
            open = false;
            invoke("unwatch", { id }).catch(() => {});
        }
    );
}

export const chatsApi = {
    /** With `worktree`, the chat works in a worktree of its own. */
    create: (cwd: string, config: ChatConfig, worktree?: NewWorktree): Promise<Chat> =>
        isTauri
            ? invoke<Chat>("create_chat", { cwd, config, worktree: worktree ?? null })
            : Promise.reject(new Error(NO_BACKEND)),

    /** A live run picks the new settings up from its next turn. */
    updateConfig: (chatId: string, config: ChatConfig): Promise<Chat> =>
        isTauri
            ? invoke<Chat>("update_chat_config", { chatId, config })
            : Promise.reject(new Error(NO_BACKEND)),

    /** A blank title clears it; the next completed turn names the chat again. */
    rename: (chatId: string, title: string | null): Promise<Chat> =>
        isTauri
            ? invoke<Chat>("rename_chat", { chatId, title })
            : Promise.reject(new Error(NO_BACKEND)),

    /** Archiving also unpins. */
    setArchived: (chatId: string, archived: boolean): Promise<Chat> =>
        isTauri
            ? invoke<Chat>("set_chat_archived", { chatId, archived })
            : Promise.reject(new Error(NO_BACKEND)),

    /** Pinning also unarchives. */
    setPinned: (chatId: string, pinned: boolean): Promise<Chat> =>
        isTauri
            ? invoke<Chat>("set_chat_pinned", { chatId, pinned })
            : Promise.reject(new Error(NO_BACKEND)),

    /** Clears the chat's unread dot. */
    markSeen: (chatId: string): Promise<Chat> =>
        isTauri
            ? invoke<Chat>("mark_chat_seen", { chatId })
            : Promise.reject(new Error(NO_BACKEND)),

    /** Deletes the chat with its transcript, stopping its run. */
    remove: (chatId: string): Promise<void> =>
        isTauri
            ? invoke<void>("delete_chat", { chatId })
            : Promise.reject(new Error(NO_BACKEND)),

    /** Settled, or `pending` for a prompt queued behind the running turn. */
    queueCommand: (chatId: string, payload: CommandPayload): Promise<Command> =>
        isTauri
            ? invoke<Command>("queue_command", { chatId, payload })
            : Promise.reject(new Error(NO_BACKEND)),

    /** Withdraws a prompt still waiting behind the running turn. */
    cancelQueued: (chatId: string, commandId: string): Promise<Command> =>
        isTauri
            ? invoke<Command>("cancel_queued", { chatId, commandId })
            : Promise.reject(new Error(NO_BACKEND)),

    /** Puts the listed queued prompts first, in that order. */
    reorderQueue: (chatId: string, commandIds: string[]): Promise<void> =>
        isTauri
            ? invoke<void>("reorder_queue", { chatId, commandIds })
            : Promise.reject(new Error(NO_BACKEND)),

    /** Runs a queued prompt next, interrupting the running turn if any. */
    sendQueuedNow: (chatId: string, commandId: string): Promise<void> =>
        isTauri
            ? invoke<void>("send_queued_now", { chatId, commandId })
            : Promise.reject(new Error(NO_BACKEND)),

    /** Stops one of the session's background tasks (`Session.background`). */
    stopTask: (chatId: string, taskId: string): Promise<void> =>
        isTauri
            ? invoke<void>("stop_background_task", { chatId, taskId })
            : Promise.reject(new Error(NO_BACKEND)),

    /** Answers a secret card (`Session.secrets`): the value is saved for the agent, null declines. */
    answerSecret: (chatId: string, requestId: string, value: string | null): Promise<void> =>
        isTauri
            ? invoke<void>("answer_secret_request", { chatId, requestId, value })
            : Promise.reject(new Error(NO_BACKEND)),

    /** The end of a background shell's output (its last 8 KiB). */
    taskOutput: (chatId: string, taskId: string): Promise<TaskOutput> =>
        isTauri
            ? invoke<TaskOutput>("background_task_output", { chatId, taskId })
            : Promise.reject(new Error(NO_BACKEND)),

    /** A snapshot, then every change to the list and live sessions. */
    watchChats: (onUpdate: (update: ChatsUpdate) => void): Promise<Unwatch> => {
        if (!isTauri) {
            onUpdate({ type: "snapshot", chats: [], sessions: [] });
            return Promise.resolve(() => {});
        }
        return watch("watch_chats", {}, onUpdate);
    },

    /** A snapshot, then every message, event and command in the chat. */
    watchMessages: (
        chatId: string,
        onUpdate: (update: MessagesUpdate) => void
    ): Promise<Unwatch> => {
        if (!isTauri) {
            onUpdate({ type: "snapshot", messages: [], pending: [] });
            return Promise.resolve(() => {});
        }
        return watch("watch_messages", { chatId }, onUpdate);
    }
};
