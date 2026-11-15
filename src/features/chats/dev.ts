import type { AgentEvent, Chat, ChatsUpdate, Message, MessagesUpdate } from "@/proto";
import { foldEvent } from "@/features/chat/fold";

/**
 * `bun run dev`'s stand-in for the engine: chats and messages in memory
 * (seeded with a few, so the sidebar has something to show), turns scripted.
 */

type Sink<T> = (update: T) => void;

const chats: Chat[] = [];
const messages = new Map<string, Message[]>();
const working = new Set<string>();
const timers = new Map<string, number>();
const chatSinks = new Set<Sink<ChatsUpdate>>();
const messageSinks = new Map<string, Set<Sink<MessagesUpdate>>>();

const HOUR = 3_600_000;

function seed() {
    const now = Date.now();
    const chat = (cwd: string, title: string | undefined, ago: number, extra: Partial<Chat> = {}) => {
        const at = now - ago;
        chats.push({ id: crypto.randomUUID(), cwd, title, archived: false, createdAt: at, lastMessageAt: at, ...extra });
    };
    chat("C:\\dev\\outcode", "Sidebar chat list", 0.2 * HOUR);
    chat("C:\\dev\\outcode", "Fix the resize handle", 5 * HOUR, { pinnedAt: now - HOUR });
    chat("C:\\dev\\outcode", undefined, 26 * HOUR);
    chat("C:\\dev\\website", "Landing page copy", 3 * 24 * HOUR);
    chat("C:\\dev\\website", "Old experiment", 20 * 24 * HOUR, { archived: true });
}
seed();

const emitChats = (update: ChatsUpdate) => chatSinks.forEach((sink) => sink(update));
const emitMessages = (chatId: string, update: MessagesUpdate) =>
    messageSinks.get(chatId)?.forEach((sink) => sink(update));

function chatOf(chatId: string): Chat {
    const chat = chats.find((c) => c.id === chatId);
    if (!chat) throw new Error(`no chat ${chatId}`);
    return chat;
}

function save(chat: Chat): Chat {
    chats.splice(chats.findIndex((c) => c.id === chat.id), 1, chat);
    emitChats({ kind: "upsert", chat });
    return chat;
}

/** Words of `text` as deltas of `type`, a word a tick. */
const words = (type: "textDelta" | "reasoningDelta", text: string): AgentEvent[] =>
    text.split(/(?<=\s)/).map((word) => ({ type, text: word }));

/**
 * A scripted turn: a thought, a run of tool calls (reads, edits, a command
 * and a failed one), then a reply with links and the prompt echoed.
 */
function script(prompt: string): AgentEvent[] {
    type Call = Extract<AgentEvent, { type: "toolCall" }>["call"];
    const call = (id: string, call: Call): AgentEvent => ({ type: "toolCall", id, call });
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
        call("x1", { kind: "exec", command: "bun run lint" }),
        result("x1", "Found 0 warnings and 0 errors.\nFinished in 52ms on 64 files."),
        ...words(
            "textDelta",
            `Done. I touched \`src/App.tsx\` and [the styles](src/index.css:1); see [the docs](https://react.dev).\n\n> ${prompt}`
        )
    ];
}

/** Applies `event` to the chat's streaming reply and passes it on. */
function feed(chatId: string, replyId: string, event: AgentEvent) {
    const list = messages.get(chatId) ?? [];
    const reply = list.find((m) => m.id === replyId);
    if (!reply) return;
    reply.parts = foldEvent(reply.parts, event);
    emitMessages(chatId, { kind: "event", messageId: replyId, event });
    if (event.type !== "done") return;
    reply.status = event.status === "interrupted" ? "aborted" : "complete";
    reply.durationMs = Date.now() - reply.createdAt;
    emitMessages(chatId, { kind: "upsert", message: { ...reply } });
    working.delete(chatId);
    emitChats({ kind: "working", chatId, working: false });
}

function finish(chatId: string, status: "completed" | "interrupted") {
    const timer = timers.get(chatId);
    if (timer === undefined) return;
    window.clearInterval(timer);
    timers.delete(chatId);
    const reply = messages.get(chatId)?.at(-1);
    if (reply) feed(chatId, reply.id, { type: "done", status });
}

export const dev = {
    create(cwd: string): Chat {
        const chat: Chat = { id: crypto.randomUUID(), cwd, archived: false, createdAt: Date.now() };
        chats.unshift(chat);
        emitChats({ kind: "upsert", chat });
        return chat;
    },

    update(chatId: string, patch: Partial<Chat>): Chat {
        return save({ ...chatOf(chatId), ...patch });
    },

    remove(chatId: string) {
        finish(chatId, "interrupted");
        chats.splice(chats.findIndex((c) => c.id === chatId), 1);
        messages.delete(chatId);
        emitChats({ kind: "removed", id: chatId });
    },

    send(chatId: string, prompt: string) {
        if (working.has(chatId)) throw new Error("the chat is still working on the last prompt");
        const now = Date.now();
        save({ ...chatOf(chatId), lastMessageAt: now, archived: false });
        const user: Message = { id: crypto.randomUUID(), role: "user", parts: [{ kind: "text", id: "t0", text: prompt }], createdAt: now };
        const reply: Message = { id: crypto.randomUUID(), role: "assistant", parts: [], createdAt: now, status: "streaming" };
        const list = messages.get(chatId) ?? [];
        list.push(user, reply);
        messages.set(chatId, list);
        emitMessages(chatId, { kind: "upsert", message: { ...user } });
        emitMessages(chatId, { kind: "upsert", message: { ...reply } });
        working.add(chatId);
        emitChats({ kind: "working", chatId, working: true });

        const events = script(prompt);
        let i = 0;
        timers.set(
            chatId,
            window.setInterval(() => {
                if (i < events.length) feed(chatId, reply.id, events[i++]!);
                else finish(chatId, "completed");
            }, 40)
        );
    },

    interrupt(chatId: string) {
        finish(chatId, "interrupted");
    },

    watchChats(sink: Sink<ChatsUpdate>) {
        sink({ kind: "snapshot", chats: [...chats], working: [...working] });
        chatSinks.add(sink);
        return () => void chatSinks.delete(sink);
    },

    watchMessages(chatId: string, sink: Sink<MessagesUpdate>) {
        sink({ kind: "snapshot", messages: (messages.get(chatId) ?? []).map((m) => ({ ...m })) });
        const sinks = messageSinks.get(chatId) ?? new Set();
        sinks.add(sink);
        messageSinks.set(chatId, sinks);
        return () => void sinks.delete(sink);
    }
};
