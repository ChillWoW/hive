import type { Message } from "@/proto";

/** What a prompt says: its text parts, a blank line apart. */
export function promptText(message: Message): string {
    return message.parts.flatMap((p) => (p.kind === "text" ? [p.text] : [])).join("\n\n");
}
