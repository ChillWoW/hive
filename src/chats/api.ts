import { Channel, invoke } from "@tauri-apps/api/core";
import type {
    Chat,
    ChatConfig,
    ChatsUpdate,
    Command,
    CommandPayload,
    MessagesUpdate,
    NewWorktree,
    TaskOutput,
    WorktreeStep
} from "@/proto";
import { backend } from "@/lib/backend";
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

const offline = () => Promise.reject(new Error(NO_BACKEND));

/** Invokes `command`; rejects under `bun run dev`. */
function call<T>(command: string, args: Record<string, unknown>): Promise<T> {
    return backend<T>(command, args, offline);
}

export const chatsApi = {
    /**
     * With `worktree`, the chat works in a worktree of its own;
     * `onProgress` hears each step of making it.
     */
    create: (
        cwd: string,
        config: ChatConfig,
        worktree?: NewWorktree,
        onProgress?: (step: WorktreeStep) => void
    ): Promise<Chat> => {
        if (!isTauri) return offline();
        const channel = new Channel<WorktreeStep>();
        if (onProgress) channel.onmessage = onProgress;
        return invoke<Chat>("create_chat", {
            cwd,
            config,
            worktree: worktree ?? null,
            onProgress: channel
        });
    },

    /**
     * Continues a chat in a new one with `config` (another harness): same
     * folder and worktree; a summary of this one goes with its first prompt.
     */
    handoff: (chatId: string, config: ChatConfig): Promise<Chat> =>
        call<Chat>("handoff_chat", { chatId, config }),

    /** A live run picks the new settings up from its next turn. */
    updateConfig: (chatId: string, config: ChatConfig): Promise<Chat> =>
        call<Chat>("update_chat_config", { chatId, config }),

    /** A blank title clears it; the next completed turn names the chat again. */
    rename: (chatId: string, title: string | null): Promise<Chat> =>
        call<Chat>("rename_chat", { chatId, title }),

    /** Archiving also unpins. */
    setArchived: (chatId: string, archived: boolean): Promise<Chat> =>
        call<Chat>("set_chat_archived", { chatId, archived }),

    /** Pinning also unarchives. */
    setPinned: (chatId: string, pinned: boolean): Promise<Chat> =>
        call<Chat>("set_chat_pinned", { chatId, pinned }),

    /** Clears the chat's unread dot. */
    markSeen: (chatId: string): Promise<Chat> =>
        call<Chat>("mark_chat_seen", { chatId }),

    /** Deletes the chat with its transcript, stopping its run. */
    remove: (chatId: string): Promise<void> =>
        call<void>("delete_chat", { chatId }),

    /** Settled, or `pending` for a prompt queued behind the running turn. */
    queueCommand: (chatId: string, payload: CommandPayload): Promise<Command> =>
        call<Command>("queue_command", { chatId, payload }),

    /** Withdraws a prompt still waiting behind the running turn. */
    cancelQueued: (chatId: string, commandId: string): Promise<Command> =>
        call<Command>("cancel_queued", { chatId, commandId }),

    /** Puts the listed queued prompts first, in that order. */
    reorderQueue: (chatId: string, commandIds: string[]): Promise<void> =>
        call<void>("reorder_queue", { chatId, commandIds }),

    /** Runs a queued prompt next, interrupting the running turn if any. */
    sendQueuedNow: (chatId: string, commandId: string): Promise<void> =>
        call<void>("send_queued_now", { chatId, commandId }),

    /** Stops one of the session's background tasks (`Session.background`). */
    stopTask: (chatId: string, taskId: string): Promise<void> =>
        call<void>("stop_background_task", { chatId, taskId }),

    /** Answers a secret card (`Session.secrets`): the value is saved for the agent, null declines. */
    answerSecret: (chatId: string, requestId: string, value: string | null): Promise<void> =>
        call<void>("answer_secret_request", { chatId, requestId, value }),

    /** The end of a background shell's output (its last 8 KiB). */
    taskOutput: (chatId: string, taskId: string): Promise<TaskOutput> =>
        call<TaskOutput>("background_task_output", { chatId, taskId }),

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
