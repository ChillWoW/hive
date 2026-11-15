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
    error?: string;
};

export type Message = UserMessage | AssistantMessage;

type ChatState = {
    messages: Message[];
    /** The run the last assistant message is streaming from. */
    runId: string | null;
    send: (prompt: string) => void;
    apply: (runId: string, event: AgentEvent) => void;
};

/**
 * The one chat there is for now. Each prompt starts its own Claude run, so
 * Claude doesn't yet see earlier turns.
 */
export const useChatStore = create<ChatState>()((set, get) => {
    /** `patch` applied to the assistant message `runId` is writing. */
    const updateReply = (runId: string, patch: (m: AssistantMessage) => Partial<AssistantMessage>) =>
        set((s) => ({
            messages: s.messages.map((m) =>
                m.id === runId && m.role === "assistant" ? { ...m, ...patch(m) } : m
            )
        }));

    return {
        messages: [],
        runId: null,

        send: (prompt) => {
            const text = prompt.trim();
            if (!text || get().runId) return;
            const runId = crypto.randomUUID();
            set((s) => ({
                runId,
                messages: [
                    ...s.messages,
                    { id: crypto.randomUUID(), role: "user", text },
                    { id: runId, role: "assistant", text: "", streaming: true }
                ]
            }));
            chatApi.send(runId, { cwd: "", prompt: text }).catch((error: unknown) => {
                updateReply(runId, () => ({ streaming: false, error: String(error) }));
                set({ runId: null });
            });
        },

        apply: (runId, event) => {
            switch (event.type) {
                case "textDelta":
                    updateReply(runId, (m) => ({ text: m.text + event.text }));
                    break;
                case "error":
                    updateReply(runId, (m) => ({
                        error: m.error ? `${m.error}\n${event.message}` : event.message
                    }));
                    break;
                case "done":
                    updateReply(runId, () => ({ streaming: false }));
                    if (get().runId === runId) set({ runId: null });
                    break;
            }
        }
    };
});

/** A turn is running. */
export const useChatBusy = () => useChatStore((s) => s.runId !== null);
