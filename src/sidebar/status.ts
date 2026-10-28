import { isUnseen } from "@/chats";
import type { Chat, Session } from "@/proto";

export type ChatStatus = "working" | "input" | "error" | "unseen" | "idle";

export function statusOf(chat: Chat, session: Session | undefined): ChatStatus {
    switch (session?.status) {
        case "working":
            return "working";
        case "awaitingInput":
            return "input";
        case "errored":
            return "error";
    }
    return isUnseen(chat) ? "unseen" : "idle";
}

export const STATUS: Record<ChatStatus, { label: string; className: string }> = {
    // Dot matrices, as the transcript's working line: cycling and neutral
    // while working, every dot lit and pulsing in the warning tone while
    // waiting. Their dots take the text colour.
    working: { label: "Working", className: "text-dark-100" },
    input: { label: "Waiting for you", className: "animate-pulse text-warning" },
    error: { label: "Errored", className: "bg-danger" },
    // Finished while you were elsewhere: ready for you.
    unseen: { label: "New activity", className: "bg-success" },
    idle: { label: "", className: "bg-dark-500" }
};
