import { chats } from "@/chats";
import { composer } from "@/composer";
import { fitConfig } from "@/harnesses";
import type { Chat, ChatConfig, HarnessCatalog } from "@/proto";

/** What a handed-off chat's composer starts with when the old draft was empty. */
const CONTINUE_PROMPT = "Continue where the previous agent left off.";

/**
 * "Continue in …": hands `chat` to another agent (after t3code's context
 * handoff, but into a new chat). The engine makes the chat, in the same
 * folder and worktree, and writes a summary of this one in the background
 * (`Chat.handoff`), which goes to the agent with the first prompt. The
 * unsent draft moves over with its files and diff comments; an empty one
 * becomes a "continue" prompt, so Enter is enough.
 */
export async function continueIn(chat: Chat, config: ChatConfig): Promise<Chat> {
    const next = await chats.handoff(chat.id, config);
    composer.moveDraft(chat.id, next.id);
    if (!composer.draft(next.id).trim()) composer.setDraft(next.id, CONTINUE_PROMPT);
    composer.focus();
    return next;
}

/** `chat`'s settings carried to `catalog`'s harness, on its default model. */
export function handoffConfig(chat: Chat, catalog: HarnessCatalog): ChatConfig {
    return fitConfig(catalog, { ...chat.config, harness: catalog.id, model: undefined });
}

/** Why `chat` can't be handed off now, else null. */
export function handoffBlocked(busy: boolean, hasPrompt: boolean): string | null {
    if (busy) return "Wait for the agent to finish first.";
    if (!hasPrompt) return "Send a prompt first.";
    return null;
}
