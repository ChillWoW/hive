import type { TranscriptMessage } from "@/chats";

export type MinimapItem = {
    /** The prompt's message id; its turn is the transcript's `[data-turn]` with it. */
    id: string;
    prompt: TranscriptMessage;
    /** The turn's last reply, if one came. */
    reply?: TranscriptMessage;
};

/** A tick per prompt, with the reply that ended its turn. */
export function minimapItems(messages: TranscriptMessage[], skip: (m: TranscriptMessage) => boolean): MinimapItem[] {
    const items: MinimapItem[] = [];
    for (const message of messages) {
        if (message.role === "user") {
            if (!skip(message)) items.push({ id: message.id, prompt: message });
        } else if (items.length) {
            items[items.length - 1].reply = message;
        }
    }
    return items;
}
