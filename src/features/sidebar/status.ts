export type ChatStatus = "asking" | "working" | "unread" | "idle";

export const STATUS: Record<ChatStatus, { label: string; className: string }> = {
    // Waiting on the user: an approval, a question, a plan or a secret.
    asking: { label: "Needs your answer", className: "bg-warning animate-pulse" },
    // A dot matrix, as the transcript's working line.
    working: { label: "Working", className: "text-text/85" },
    unread: { label: "Finished", className: "bg-info" },
    idle: { label: "", className: "bg-muted/40" }
};
