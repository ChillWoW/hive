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

/** Words of `text` as deltas of `type`, a word a tick. */
const words = (type: "textDelta" | "reasoningDelta", text: string): AgentEvent[] =>
    text.split(/(?<=\s)/).map((word) => ({ type, text: word }));

/**
 * A scripted turn for `bun run dev` without a backend: a thought, a run of
 * tool calls (reads, edits, a command and a failed one), then a reply with
 * links and the prompt echoed.
 */
function devScript(prompt: string): AgentEvent[] {
    const call = (id: string, call: Extract<AgentEvent, { type: "toolCall" }>["call"]): AgentEvent => ({
        type: "toolCall",
        id,
        call
    });
    const result = (id: string, output?: string, isError = false): AgentEvent => ({
        type: "toolResult",
        id,
        isError,
        output
    });
    return [
        ...words("reasoningDelta", "**Looking around**\n\nNo backend under `bun run dev`, so this turn is scripted. "),
        call("r1", { kind: "readFile", path: "src/main.tsx" }),
        result("r1", '     1→import { createRoot } from "react-dom/client";\n     2→import { App } from "./App";\n'),
        call("e1", { kind: "editFile", path: "src/App.tsx", oldString: "const a = 1;\n", newString: "const a = 2;\nconst b = 3;\n" }),
        result("e1", "ok"),
        call("e2", { kind: "editFile", path: "src/index.css", oldString: "a {}\n", newString: "a { color: red; }\n" }),
        result("e2", "ok"),
        call("x1", { kind: "exec", command: "bun run lint" }),
        result("x1", "Found 0 warnings and 0 errors.\nFinished in 52ms on 64 files."),
        call("x2", { kind: "exec", command: "cargo test -p nope" }),
        result("x2", "error: package ID specification `nope` did not match any packages", true),
        ...words(
            "textDelta",
            `Done. I touched \`src/App.tsx\` and [the styles](src/index.css:1); see [the docs](https://react.dev).\n\n> ${prompt}`
        )
    ];
}

function devSend(chatId: string, request: RunRequest) {
    const script = devScript(request.prompt);
    let i = 0;
    const timer = window.setInterval(() => {
        if (i < script.length) return devEmit(chatId, script[i++]!);
        devStop(chatId, "completed");
    }, 40);
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
