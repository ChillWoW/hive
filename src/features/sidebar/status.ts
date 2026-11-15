export type ChatStatus = "working" | "idle";

export const STATUS: Record<ChatStatus, { label: string; className: string }> = {
    // A dot matrix, as the transcript's working line.
    working: { label: "Working", className: "text-text/85" },
    idle: { label: "", className: "bg-muted/40" }
};
