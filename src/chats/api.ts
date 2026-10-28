import { Channel, invoke } from "@tauri-apps/api/core";
import type {
    Chat,
    ChatConfig,
    ChatsUpdate,
    Command,
    CommandPayload,
    MessagesUpdate
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
    create: (cwd: string, config: ChatConfig): Promise<Chat> =>
        isTauri
            ? invoke<Chat>("create_chat", { cwd, config })
            : Promise.reject(new Error(NO_BACKEND)),

    /** A live run picks the new settings up from its next turn. */
    updateConfig: (chatId: string, config: ChatConfig): Promise<Chat> =>
        isTauri
            ? invoke<Chat>("update_chat_config", { chatId, config })
            : Promise.reject(new Error(NO_BACKEND)),

    /** Settled, or `pending` for a prompt queued behind the running turn. */
    queueCommand: (chatId: string, payload: CommandPayload): Promise<Command> =>
        isTauri
            ? invoke<Command>("queue_command", { chatId, payload })
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
