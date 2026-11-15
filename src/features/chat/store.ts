import { create } from "zustand";
import type { AgentEvent, Message, MessagePart } from "@/proto";
import { getHomeDir } from "@/lib/home";
import { chatApi } from "./api";
import { foldEvent } from "./fold";

type ChatState = {
    /** The one chat there is for now; its Claude run lives across prompts. */
    chatId: string;
    /** Where it works: the home folder, once known (empty: the backend picks it). */
    cwd: string;
    messages: Message[];
    /** The assistant message the running turn writes. */
    replyId: string | null;
    send: (prompt: string) => void;
    stop: () => void;
    apply: (chatId: string, event: AgentEvent) => void;
};

export const useChatStore = create<ChatState>()((set, get) => {
    /** `patch` applied to the reply being written. */
    const updateReply = (patch: (m: Message) => Partial<Message>) => {
        const { replyId } = get();
        if (!replyId) return;
        set((s) => ({
            messages: s.messages.map((m) => (m.id === replyId ? { ...m, ...patch(m) } : m))
        }));
    };
    const errorPart = (parts: MessagePart[], message: string) =>
        foldEvent(parts, { type: "error", message });

    void getHomeDir().then((home) => {
        if (home && !get().cwd) set({ cwd: home });
    });

    return {
        chatId: crypto.randomUUID(),
        cwd: "",
        messages: [],
        replyId: null,

        send: (prompt) => {
            const text = prompt.trim();
            if (!text || get().replyId) return;
            const replyId = crypto.randomUUID();
            const now = Date.now();
            set((s) => ({
                replyId,
                messages: [
                    ...s.messages,
                    {
                        id: crypto.randomUUID(),
                        role: "user",
                        parts: [{ kind: "text", id: "t0", text }],
                        createdAt: now
                    },
                    { id: replyId, role: "assistant", parts: [], createdAt: now, status: "streaming" }
                ]
            }));
            const { chatId, cwd } = get();
            chatApi.send(chatId, { cwd, prompt: text }).catch((error: unknown) => {
                updateReply((m) => ({
                    status: "complete",
                    parts: errorPart(m.parts, String(error))
                }));
                set({ replyId: null });
            });
        },

        stop: () => {
            if (get().replyId) void chatApi.interrupt(get().chatId);
        },

        apply: (chatId, event) => {
            if (chatId !== get().chatId) return;
            updateReply((m) => {
                const parts = foldEvent(m.parts, event);
                if (event.type !== "done") return { parts };
                return {
                    parts,
                    status: event.status === "interrupted" ? "aborted" : "complete",
                    durationMs: Date.now() - m.createdAt
                };
            });
            if (event.type === "done") set({ replyId: null });
        }
    };
});

/** A turn is running. */
export const useChatBusy = () => useChatStore((s) => s.replyId !== null);
