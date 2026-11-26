import type {
    AgentEvent,
    Attachment,
    Chat,
    ChatConfig,
    ChatsUpdate,
    InputRequest,
    InputResponse,
    Message,
    MessagesUpdate,
    NewWorktree,
    Session,
    SlashCommand,
    WorktreeStep
} from "@/proto";
import { foldEvent, stampEvent } from "@/features/chat/fold";
import { baseName } from "@/lib/paths";

/**
 * `bun run dev`'s stand-in for the engine: chats and messages in memory
 * (seeded with a few, so the sidebar has something to show), turns
 * scripted. A prompt asking for a plan, a question or (outside full access)
 * a command waits on the matching card.
 */

type Sink<T> = (update: T) => void;

const chats: Chat[] = [];
const messages = new Map<string, Message[]>();
const sessions = new Map<string, Session>();
const timers = new Map<string, number>();
/** What each running turn still has to play, and what it waits on. */
const scripts = new Map<string, { reply: string; events: AgentEvent[]; waiting?: string }>();
const chatSinks = new Set<Sink<ChatsUpdate>>();
const messageSinks = new Map<string, Set<Sink<MessagesUpdate>>>();
const urls = new Map<string, string>();

const HOUR = 3_600_000;

const DEV_COMMANDS: SlashCommand[] = [
    { name: "compact", description: "Free up context by summarizing the conversation", inputHint: "<instructions>", kind: "command" },
    { name: "context", description: "Show what fills the context window", kind: "command" },
    { name: "cost", description: "Show the session's cost and duration", kind: "command" },
    { name: "init", description: "Write a CLAUDE.md describing the codebase", kind: "command" },
    { name: "review", description: "Review a pull request", kind: "command" },
    { name: "simplify", description: "Review changed code for reuse and simplification", kind: "skill" }
];

function seed() {
    const now = Date.now();
    const chat = (cwd: string, title: string | undefined, ago: number, extra: Partial<Chat> = {}) => {
        const at = now - ago;
        chats.push({
            id: crypto.randomUUID(),
            cwd,
            title,
            config: { harness: "claude", modelOptions: {}, access: "full-access", plan: false },
            archived: false,
            createdAt: at,
            lastMessageAt: at,
            ...extra
        });
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

function sessionOf(chatId: string): Session {
    return sessions.get(chatId) ?? { chatId, working: false, queued: [], held: false, tasks: [], commands: [], secrets: [] };
}

function setSession(chatId: string, patch: Partial<Session>) {
    const session = { ...sessionOf(chatId), ...patch };
    sessions.set(chatId, session);
    emitChats({ kind: "session", session });
}

/** Words of `text` as deltas of `type`, a word a tick. */
const words = (type: "textDelta" | "reasoningDelta", text: string): AgentEvent[] =>
    text.split(/(?<=\s)/).map((word) => ({ type, text: word }));

type Call = Extract<AgentEvent, { type: "toolCall" }>["call"];
const call = (id: string, call: Call): AgentEvent => ({ type: "toolCall", id, call });
const result = (id: string, output?: string, isError = false): AgentEvent => ({ type: "toolResult", id, isError, output });
const ask = (requestId: string, request: InputRequest): AgentEvent => ({ type: "inputRequested", requestId, request });

/**
 * A scripted turn: a thought, a run of tool calls (reads, edits, a command),
 * a subagent, then a reply with links and the prompt echoed. Asking for a
 * plan, a question or (outside full access) a command adds its card.
 */
function script(prompt: string, config: ChatConfig): AgentEvent[] {
    const lower = prompt.toLowerCase();
    if (lower.startsWith("/compact")) {
        return [
            { type: "compaction", status: "running", auto: false },
            { type: "compaction", status: "completed", auto: false, beforeTokens: 84_000, afterTokens: 12_000 },
            { type: "contextUsage", tokens: 12_000 }
        ];
    }
    if (config.plan) {
        return [
            ...words("reasoningDelta", "**Planning**\n\nPlan mode: exploring first. "),
            call("p1", { kind: "readFile", path: "src/App.tsx" }),
            result("p1", "     1→export function App() {}\n"),
            ask("plan", {
                kind: "plan",
                plan: `## Plan\n\n1. Read \`src/App.tsx\` and the layout.\n2. ${prompt}\n3. Run \`bun run lint\` and \`bun run build\`.`
            }),
            ...words("textDelta", "Implementing the approved plan now.")
        ];
    }
    const events: AgentEvent[] = [
        ...words("reasoningDelta", "**Looking around**\n\nNo backend under `bun run dev`, so this turn is scripted. "),
        { type: "contextUsage", tokens: 48_000, window: 200_000 },
        call("r1", { kind: "readFile", path: "src/main.tsx" }),
        result("r1", '     1→import { createRoot } from "react-dom/client";\n     2→import { App } from "./App";\n')
    ];
    if (lower.includes("question") || lower.includes("ask")) {
        events.push(
            ask("q", {
                kind: "questions",
                questions: [
                    {
                        id: "q0",
                        header: "Approach",
                        question: "Which way should the sidebar collapse?",
                        options: [
                            { label: "To icons", description: "Keep a 48px rail with project icons" },
                            { label: "Fully", description: "Hide it; a button brings it back" }
                        ],
                        multiSelect: false
                    },
                    {
                        id: "q1",
                        header: "Extras",
                        question: "Anything else to include?",
                        options: [{ label: "Animation" }, { label: "Keyboard shortcut" }, { label: "Remember state" }],
                        multiSelect: true
                    }
                ]
            })
        );
    }
    events.push(
        call("e1", { kind: "editFile", path: "src/App.tsx", oldString: "const a = 1;\n", newString: "const a = 2;\nconst b = 3;\n" }),
        result("e1", "ok"),
        call("s1", { kind: "subagent", description: "Scan the styles", agent: "Explore", prompt: "Find every use of --accent." }),
        { type: "subagent", parentToolId: "s1", event: { type: "textDelta", text: "Looking through `src/index.css`.\n\n" } },
        { type: "subagent", parentToolId: "s1", event: call("s1r", { kind: "search", pattern: "--accent", path: "src" }) },
        { type: "subagent", parentToolId: "s1", event: result("s1r", "src/index.css:12\nsrc/ui/Button.tsx:40") },
        { type: "subagent", parentToolId: "s1", event: { type: "textDelta", text: "Two uses: the theme and the button." } },
        { type: "subagent", parentToolId: "s1", event: { type: "done", status: "completed" } },
        result("s1", "Two uses: the theme and the button.")
    );
    if (config.access !== "full-access") {
        events.push(
            call("x1", { kind: "exec", command: "bun run lint" }),
            ask("x1", { kind: "approval", title: "Run command", call: { kind: "exec", command: "bun run lint" }, toolCallId: "x1", reason: "Check the change" })
        );
    } else {
        events.push(call("x1", { kind: "exec", command: "bun run lint" }));
    }
    events.push(
        result("x1", "Found 0 warnings and 0 errors.\nFinished in 52ms on 64 files.")
    );
    // Asking for background work leaves a shell and an agent running past the turn.
    if (lower.includes("background")) {
        events.push(
            call("b1", { kind: "exec", command: "bun run dev --port 5173" }),
            result("b1", "Running in the background."),
            call("b2", { kind: "subagent", description: "Watch the build", agent: "general-purpose", prompt: "Watch the dev build and report errors." }),
            { type: "subagent", parentToolId: "b2", event: { type: "textDelta", text: "Watching the build output for errors." } },
            result("b2", "Async agent launched."),
            {
                type: "backgroundTasks",
                tasks: [
                    { id: "t1", kind: "shell", description: "Dev server", toolCallId: "b1" },
                    { id: "t2", kind: "agent", description: "Watch the build", toolCallId: "b2", agentType: "general-purpose" }
                ]
            }
        );
    }
    events.push(
        ...words(
            "textDelta",
            `Done. I touched \`src/App.tsx\` and [the styles](src/index.css:1); see [the docs](https://react.dev).\n\n> ${prompt}`
        ),
        { type: "usage", inputTokens: 1200, outputTokens: 300 }
    );
    return events;
}

/** Applies `event` to the chat's streaming reply and passes it on. */
function feed(chatId: string, replyId: string, event: AgentEvent) {
    if (event.type === "contextUsage") {
        const context = sessionOf(chatId).context ?? {};
        setSession(chatId, {
            context: { tokens: event.tokens ?? context.tokens, window: event.window ?? context.window }
        });
        return;
    }
    if (event.type === "backgroundTasks") {
        setSession(chatId, { tasks: event.tasks });
        return;
    }
    const list = messages.get(chatId) ?? [];
    const reply = list.find((m) => m.id === replyId);
    if (!reply) return;
    reply.parts = stampEvent(foldEvent(reply.parts, event), event, Date.now());
    emitMessages(chatId, { kind: "event", messageId: replyId, event });
    if (event.type !== "done") return;
    reply.status = event.status === "interrupted" ? "aborted" : "complete";
    reply.durationMs = Date.now() - reply.createdAt;
    emitMessages(chatId, { kind: "upsert", message: { ...reply } });
}

/** Plays the chat's script a tick at a time until it ends or asks something. */
function play(chatId: string) {
    const turn = scripts.get(chatId);
    if (!turn || timers.has(chatId)) return;
    timers.set(
        chatId,
        window.setInterval(() => {
            const event = turn.events.shift();
            if (!event) return finish(chatId, "completed");
            feed(chatId, turn.reply, event);
            if (event.type === "inputRequested") {
                turn.waiting = event.requestId;
                window.clearInterval(timers.get(chatId));
                timers.delete(chatId);
            }
        }, 40)
    );
}

function finish(chatId: string, status: "completed" | "interrupted") {
    const timer = timers.get(chatId);
    if (timer !== undefined) window.clearInterval(timer);
    timers.delete(chatId);
    const turn = scripts.get(chatId);
    if (!turn) return;
    scripts.delete(chatId);
    feed(chatId, turn.reply, { type: "done", status });
    // As the store does: a turn's end is its chat's latest activity.
    save({ ...chatOf(chatId), lastMessageAt: Date.now() });
    const session = sessionOf(chatId);
    const held = session.held && status === "interrupted";
    setSession(chatId, { working: false, held });
    const [next, ...rest] = session.queued;
    if (next && !held) {
        setSession(chatId, { queued: rest });
        start(chatId, next.prompt, next.attachments ?? []);
    }
}

function start(chatId: string, prompt: string, attachments: Attachment[]) {
    const now = Date.now();
    const chat = save({ ...chatOf(chatId), lastMessageAt: now, archived: false });
    const user: Message = {
        id: crypto.randomUUID(),
        role: "user",
        parts: [{ kind: "text", id: "t0", text: prompt }],
        attachments,
        createdAt: now
    };
    const reply: Message = { id: crypto.randomUUID(), role: "assistant", parts: [], createdAt: now, status: "streaming" };
    const list = messages.get(chatId) ?? [];
    list.push(user, reply);
    messages.set(chatId, list);
    emitMessages(chatId, { kind: "upsert", message: { ...user } });
    emitMessages(chatId, { kind: "upsert", message: { ...reply } });
    setSession(chatId, { working: true, commands: DEV_COMMANDS });
    // The title run, played by the prompt's first words in Title Case.
    if (!chat.title) {
        window.setTimeout(() => {
            const chat = chats.find((c) => c.id === chatId);
            if (!chat || chat.title) return;
            const words = prompt.split(/\s+/).filter(Boolean).slice(0, 4);
            const title = words.map((w) => w[0]!.toUpperCase() + w.slice(1)).join(" ");
            save({ ...chat, title });
        }, 700);
    }
    scripts.set(chatId, { reply: reply.id, events: script(prompt, chat.config) });
    play(chatId);
}

export const dev = {
    create(cwd: string, config: ChatConfig): Chat {
        const chat: Chat = { id: crypto.randomUUID(), cwd, config, archived: false, createdAt: Date.now() };
        chats.unshift(chat);
        emitChats({ kind: "upsert", chat });
        return chat;
    },

    /** A made-up worktree, its steps played out over a couple of seconds. */
    async createInWorktree(
        cwd: string,
        config: ChatConfig,
        worktree: NewWorktree,
        onProgress?: (step: WorktreeStep) => void
    ): Promise<Chat> {
        const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));
        const words = (worktree.hint ?? "").toLowerCase().match(/[a-z0-9]+/g) ?? [];
        const branch = `outcode/${words.slice(0, 5).join("-") || "chat"}`;
        onProgress?.({ step: "naming" });
        await wait(900);
        onProgress?.({ step: "checkingOut", branch });
        await wait(1200);
        const root = `~/.outcode/worktrees/a1b2c3d4/${baseName(cwd) || "repo"}`;
        const chat = this.create(cwd, config);
        return save({ ...chat, worktree: { root, path: root, branch, base: worktree.base ?? "main" } });
    },

    update(chatId: string, patch: Partial<Chat>): Chat {
        return save({ ...chatOf(chatId), ...patch });
    },

    remove(chatId: string) {
        finish(chatId, "interrupted");
        chats.splice(chats.findIndex((c) => c.id === chatId), 1);
        messages.delete(chatId);
        sessions.delete(chatId);
        emitChats({ kind: "removed", id: chatId });
    },

    send(chatId: string, prompt: string, attachments: Attachment[]) {
        if (sessionOf(chatId).working) {
            const queued = [...sessionOf(chatId).queued, { id: crypto.randomUUID(), prompt, attachments }];
            setSession(chatId, { queued });
            return;
        }
        start(chatId, prompt, attachments);
    },

    interrupt(chatId: string) {
        if (!sessionOf(chatId).working) return;
        setSession(chatId, { held: sessionOf(chatId).queued.length > 0 });
        finish(chatId, "interrupted");
    },

    answer(chatId: string, requestId: string, response: InputResponse) {
        const turn = scripts.get(chatId);
        if (!turn || turn.waiting !== requestId) return;
        turn.waiting = undefined;
        feed(chatId, turn.reply, { type: "inputResolved", requestId, response });
        const refused =
            (response.kind === "approval" && response.decision === "deny") ||
            (response.kind === "plan" && !response.approve);
        if (response.kind === "plan" && response.approve) save({ ...chatOf(chatId), config: { ...chatOf(chatId).config, plan: false } });
        if (refused) {
            turn.events = words("textDelta", response.kind === "plan" ? "Keeping to the plan stage." : "Skipped that, as asked.");
        }
        play(chatId);
    },

    stopTask(chatId: string, taskId: string) {
        setSession(chatId, { tasks: sessionOf(chatId).tasks.filter((t) => t.id !== taskId) });
    },

    cancelQueued(chatId: string, id: string) {
        const queued = sessionOf(chatId).queued.filter((q) => q.id !== id);
        setSession(chatId, { queued, held: sessionOf(chatId).held && queued.length > 0 });
    },

    sendQueuedNow(chatId: string, id: string) {
        const session = sessionOf(chatId);
        const item = session.queued.find((q) => q.id === id);
        if (!item) return;
        setSession(chatId, { queued: [item, ...session.queued.filter((q) => q.id !== id)], held: false });
        if (session.working) finish(chatId, "interrupted");
        else {
            setSession(chatId, { queued: sessionOf(chatId).queued.slice(1) });
            start(chatId, item.prompt, item.attachments ?? []);
        }
    },

    reorderQueued(chatId: string, ids: string[]) {
        const rank = (id: string) => (ids.includes(id) ? ids.indexOf(id) : Infinity);
        setSession(chatId, { queued: [...sessionOf(chatId).queued].sort((a, b) => rank(a.id) - rank(b.id)) });
    },

    commands: () => DEV_COMMANDS,

    saveAttachment(name: string, data: string): Attachment {
        const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
        const image = /\.(png|jpe?g|gif|webp)$/i.test(name);
        const mimeType = image ? `image/${name.split(".").pop()!.toLowerCase().replace("jpg", "jpeg")}` : "text/plain";
        const path = `C:\\Users\\dev\\.outcode.dev\\attachments\\${crypto.randomUUID()}\\${name}`;
        urls.set(path, `data:${mimeType};base64,${data}`);
        return { path, name, mimeType, size: bytes.length };
    },

    attachmentUrl: (path: string) => urls.get(path) ?? "",

    watchChats(sink: Sink<ChatsUpdate>) {
        sink({ kind: "snapshot", chats: [...chats], sessions: [...sessions.values()] });
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
