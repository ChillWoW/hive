import type { TranscriptMessage } from "@/chats";

/** What a prompt says: its text parts, a blank line apart. */
export function promptText(message: TranscriptMessage): string {
    return message.parts.flatMap((p) => (p.kind === "text" ? [p.text] : [])).join("\n\n");
}
