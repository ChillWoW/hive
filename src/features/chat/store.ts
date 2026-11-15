import { create } from "zustand";
import type { AgentEvent } from "@/proto";
import { chatApi } from "./api";

export type UserMessage = { id: string; role: "user"; text: string };

export type AssistantMessage = {
    id: string;
    role: "assistant";
    text: string;
    /** Still being written. */
    streaming: boolean;
    /** The user stopped it. */
    stopped?: boolean;
    error?: string;
};

export type Message = UserMessage | AssistantMessage;

type ChatState = {
    /** The one chat there is for now; its Claude run lives across prompts. */
    chatId: string;
    messages: Message[];
    /** The assistant message the running turn writes. */
    replyId: string | null;
    send: (prompt: string) => void;
    stop: () => void;
    apply: (chatId: string, event: AgentEvent) => void;
};

export const useChatStore = create<ChatState>()((set, get) => {
    /** `patch` applied to the reply being written. */
    const updateReply = (patch: (m: AssistantMessage) => Partial<AssistantMessage>) => {
        const { replyId } = get();
        if (!replyId) return;
        set((s) => ({
            messages: s.messages.map((m) =>
                m.id === replyId && m.role === "assistant" ? { ...m, ...patch(m) } : m
            )
        }));
    };

    return {
        chatId: crypto.randomUUID(),
        messages: [],
        replyId: null,

        send: (prompt) => {
            const text = prompt.trim();
            if (!text || get().replyId) return;
            const replyId = crypto.randomUUID();
            set((s) => ({
                replyId,
                messages: [
                    ...s.messages,
                    { id: crypto.randomUUID(), role: "user", text },
                    { id: replyId, role: "assistant", text: "", streaming: true }
                ]
            }));
            chatApi.send(get().chatId, { cwd: "", prompt: text }).catch((error: unknown) => {
                updateReply(() => ({ streaming: false, error: String(error) }));
                set({ replyId: null });
            });
        },

        stop: () => {
            if (get().replyId) void chatApi.interrupt(get().chatId);
        },

        apply: (chatId, event) => {
            if (chatId !== get().chatId) return;
            switch (event.type) {
                case "textDelta":
                    updateReply((m) => ({ text: m.text + event.text }));
                    break;
                case "error":
                    updateReply((m) => ({
                        error: m.error ? `${m.error}\n${event.message}` : event.message
                    }));
                    break;
                case "done":
                    updateReply(() => ({
                        streaming: false,
                        stopped: event.status === "interrupted"
                    }));
                    set({ replyId: null });
                    break;
            }
        }
    };
});

/** A turn is running. */
export const useChatBusy = () => useChatStore((s) => s.replyId !== null);
