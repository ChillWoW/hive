/** What a chat is doing, as the sidebar shows it: the first of these that holds. */
export type ChatStatus = "asking" | "working" | "unread" | "idle";

/** The statuses worth pointing out: every one but idle, most urgent first. */
export type LiveStatus = Exclude<ChatStatus, "idle">;
export const LIVE: LiveStatus[] = ["asking", "working", "unread"];

export const STATUS: Record<ChatStatus, { label: string; className: string }> = {
    // Waiting on the user: an approval, a question, a plan or a secret.
    asking: { label: "Needs you", className: "bg-warning" },
    // Its title shimmers too, as the transcript's working line does.
    working: { label: "Working", className: "bg-muted" },
    // Replied since the user last looked.
    unread: { label: "Unread", className: "bg-info" },
    idle: { label: "", className: "bg-muted/40" }
};
