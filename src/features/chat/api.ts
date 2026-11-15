import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { AgentEvent, RunRequest } from "@/proto";
import { backend } from "@/lib/backend";
import { isTauri } from "@/lib/platform";

/**
 * The one way the UI talks to chats; components never call `backend()` for
 * them. Everything here is what a remote host would serve later.
 */

const EVENT = "chat://event";

export type RunEvent = { runId: string; event: AgentEvent };

/** A reply streamed word by word, for `bun run dev` without a backend. */
function devRun(runId: string, request: RunRequest) {
    const reply = `No backend under \`bun run dev\`, so here's an echo.\n\n> ${request.prompt}`;
    const words = reply.split(/(?<=\s)/);
    let i = 0;
    const timer = window.setInterval(() => {
        const event: AgentEvent =
            i < words.length ? { type: "textDelta", text: words[i++]! } : { type: "done" };
        devListeners.forEach((listener) => listener({ runId, event }));
        if (event.type === "done") window.clearInterval(timer);
    }, 30);
}

const devListeners = new Set<(event: RunEvent) => void>();

export const chatApi = {
    /** Starts a run; its events arrive through `onEvent`, ending with `done`. */
    send(runId: string, request: RunRequest): Promise<void> {
        return backend("chat_send", { runId, request }, () => devRun(runId, request));
    },

    onEvent(handler: (event: RunEvent) => void): Promise<UnlistenFn> {
        if (!isTauri) {
            // Its own entry even when `handler` is one already added.
            const listener = (event: RunEvent) => handler(event);
            devListeners.add(listener);
            return Promise.resolve(() => void devListeners.delete(listener));
        }
        return listen<RunEvent>(EVENT, (e) => handler(e.payload));
    }
};
