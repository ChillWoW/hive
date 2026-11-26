import type { Message } from "@/proto";
import { promptText } from "./text";

export type MinimapItem = {
    /** The prompt's message id; its turn is the transcript's `[data-turn]` with it. */
    id: string;
    prompt: Message;
    /** The turn's last reply, if one came. */
    reply?: Message;
};

/** A tick per prompt the transcript shows, with the reply that ended its turn. */
export function minimapItems(messages: Message[]): MinimapItem[] {
    const items: MinimapItem[] = [];
    for (const message of messages) {
        if (message.role === "user") {
            if (promptText(message).trim() || message.attachments?.length) {
                items.push({ id: message.id, prompt: message });
            }
        } else if (items.length) {
            items[items.length - 1]!.reply = message;
        }
    }
    return items;
}
