import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { AgentEvent, RunRequest } from "@/proto";
import { backend } from "@/lib/backend";
import { isTauri } from "@/lib/platform";

/**
 * The one way the UI talks to chats; components never call `backend()` for
 * them. Everything here is what a remote host would serve later.
 */

const EVENT = "chat://event";

export type ChatEvent = { chatId: string; event: AgentEvent };

const devListeners = new Set<(event: ChatEvent) => void>();
/** `bun run dev`'s streaming replies, by chat. */
const devTimers = new Map<string, number>();

function devEmit(chatId: string, event: AgentEvent) {
    devListeners.forEach((listener) => listener({ chatId, event }));
}

/** A reply streamed word by word, for `bun run dev` without a backend. */
function devSend(chatId: string, request: RunRequest) {
    const reply = `No backend under \`bun run dev\`, so here's an echo.\n\n> ${request.prompt}`;
    const words = reply.split(/(?<=\s)/);
    let i = 0;
    const timer = window.setInterval(() => {
        if (i < words.length) return devEmit(chatId, { type: "textDelta", text: words[i++]! });
        devStop(chatId, "completed");
    }, 30);
    devTimers.set(chatId, timer);
}

function devStop(chatId: string, status: "completed" | "interrupted") {
    const timer = devTimers.get(chatId);
    if (timer === undefined) return;
    window.clearInterval(timer);
    devTimers.delete(chatId);
    devEmit(chatId, { type: "done", status });
}

export const chatApi = {
    /**
     * Sends a prompt to the chat's live run, starting one when there's none.
     * Its events arrive through `onEvent`, the turn ending with `done`.
     */
    send(chatId: string, request: RunRequest): Promise<void> {
        return backend("chat_send", { chatId, request }, () => devSend(chatId, request));
    },

    /** Stops the chat's running turn; it ends with `done` (interrupted). */
    interrupt(chatId: string): Promise<void> {
        return backend("chat_interrupt", { chatId }, () => devStop(chatId, "interrupted"));
    },

    onEvent(handler: (event: ChatEvent) => void): Promise<UnlistenFn> {
        if (!isTauri) {
            // Its own entry even when `handler` is one already added.
            const listener = (event: ChatEvent) => handler(event);
            devListeners.add(listener);
            return Promise.resolve(() => void devListeners.delete(listener));
        }
        return listen<ChatEvent>(EVENT, (e) => handler(e.payload));
    }
};
