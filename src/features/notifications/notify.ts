import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { useChatsStore } from "@/features/chats/store";
import { settings } from "@/features/settings/store";
import { baseName } from "@/lib/paths";
import { isTauri } from "@/lib/platform";
import { setBadge } from "./badge";
import { playSound } from "./sounds";

/** What a chat can want attention for. */
export type NotificationKind = "done" | "input" | "error";

const BODY: Record<NotificationKind, string> = {
    done: "Finished",
    input: "Needs your input",
    error: "Stopped on an error"
};

const SOUND = { done: "doneSound", input: "inputSound", error: "errorSound" } as const;

let permission: Promise<boolean> | null = null;

/** Asks the system once (macOS, Linux); Windows always allows. */
function allowed(): Promise<boolean> {
    permission ??= (async () => (await isPermissionGranted()) || (await requestPermission()) === "granted")().catch(
        () => false
    );
    return permission;
}

async function desktop(title: string, body: string) {
    if (!isTauri) return;
    if (await allowed()) sendNotification({ title, body });
}

// Chats with something new since the window was last focused: the badge's count.
const unseen = new Set<string>();

/** The window is focused again: everything counts as seen. */
export function clearBadge() {
    unseen.clear();
    setBadge(0);
}

/** The chat is gone: it no longer counts. */
export function forgetChat(chatId: string) {
    if (unseen.delete(chatId)) setBadge(unseen.size);
}

/**
 * Tells the user about `chatId` the ways `notifications.*` say to: a system
 * notification, a sound, the badge. `test` (the settings page's button) skips
 * the focus check and the badge.
 */
export function notify(kind: NotificationKind, chatId: string | null, test = false) {
    const prefs = settings.get().notifications;
    const focused = document.hasFocus();
    if (!test && focused && prefs.onlyInBackground) return;
    playSound(prefs[SOUND[kind]], prefs.volume);
    if (prefs.desktop) {
        const chat = useChatsStore.getState().chats.find((c) => c.id === chatId);
        const title = chat ? chat.title?.trim() || "New chat" : "Outcode";
        const body = chat ? `${BODY[kind]} · ${baseName(chat.cwd)}` : BODY[kind];
        void desktop(title, body);
    }
    if (prefs.badge && !focused && chatId && !test) {
        unseen.add(chatId);
        setBadge(unseen.size);
    }
}
