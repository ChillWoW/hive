import type { Chat, ChatConfig, HandoffMode } from "@/proto";
import { chats, chatsApi } from "@/features/chats";
import { composer } from "@/features/composer";
import { toast } from "@/ui";

/** What a new chat's composer starts with when the old draft was empty. */
const CONTINUE_PROMPT = "Continue where the previous agent left off.";

/**
 * Hands `chat` to the agent `config` runs on (`Chat.handoffs`). In the chat
 * itself, the next prompt goes to the new agent with a summary of what came
 * before. A new chat gets the old one's unsent draft, its files with it;
 * an empty one becomes a "continue" prompt, so Enter is enough.
 */
export async function handOff(chat: Chat, config: ChatConfig, mode: HandoffMode): Promise<void> {
    try {
        const next = await chatsApi.handoff(chat.id, config, mode);
        if (mode === "newChat") {
            composer.moveDraft(chat.id, next.id);
            chats.select(next.id);
            if (!composer.draft(next.id).trim()) composer.setDraft(next.id, CONTINUE_PROMPT);
        }
        composer.focus();
    } catch (error) {
        toast.error({ title: "Couldn't hand off the chat", description: String(error) });
    }
}

/** Why `chat` can't be handed off now, else null. */
export function handoffBlocked(busy: boolean, hasPrompt: boolean): string | null {
    if (busy) return "Wait for the agent to finish first.";
    if (!hasPrompt) return "Send a prompt first.";
    return null;
}
