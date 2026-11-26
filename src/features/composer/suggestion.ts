import { useSyncExternalStore } from "react";
import { useSession } from "@/features/chats";
import { useSettingsStore } from "@/features/settings";

// Suggestions Escape dismissed, by chat: kept across remounts, so switching
// chats doesn't bring one back.
let dismissed: ReadonlyMap<string, string> = new Map();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
};
const read = () => dismissed;

/**
 * The agent's guess at the chat's next prompt, while it's worth offering:
 * the setting is on, no turn runs, the field is empty and nothing else waits
 * on the user. Tab (or the hint) takes it; Escape dismisses it.
 */
export function usePromptSuggestion(
    chatId: string | null,
    { busy, empty }: { busy: boolean; empty: boolean }
): { suggestion: string | null; dismiss: () => void } {
    const enabled = useSettingsStore((s) => s.settings.chat.promptSuggestions);
    const session = useSession(chatId);
    const gone = useSyncExternalStore(subscribe, read);
    const text = session?.suggestion ?? null;
    const offered =
        enabled &&
        chatId !== null &&
        text !== null &&
        !busy &&
        !session?.working &&
        empty &&
        !session?.secrets?.length &&
        gone.get(chatId) !== text;
    return {
        suggestion: offered ? text : null,
        dismiss: () => {
            if (!offered) return;
            dismissed = new Map(dismissed).set(chatId, text);
            for (const listener of listeners) listener();
        }
    };
}
