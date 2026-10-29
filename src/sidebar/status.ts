import { isUnseen } from "@/chats";
import type { Chat, Session } from "@/proto";

export type ChatStatus = "working" | "input" | "error" | "unseen" | "background" | "idle";

export function statusOf(chat: Chat, session: Session | undefined): ChatStatus {
    switch (session?.status) {
        case "working":
            return "working";
        case "awaitingInput":
            return "input";
        case "errored":
            return "error";
    }
    if (isUnseen(chat)) return "unseen";
    // Between turns, with agents or shells still running.
    return session?.background?.length ? "background" : "idle";
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
    // Cycling like working, dimmer and blue: work goes on without a turn.
    background: { label: "Running in the background", className: "text-info/80" },
    idle: { label: "", className: "bg-dark-500" }
};
