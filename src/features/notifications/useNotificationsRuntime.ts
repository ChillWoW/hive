import { useEffect } from "react";
import { chatsApi, type Unwatch } from "@/features/chats/api";
import { useChatsStore } from "@/features/chats/store";
import { useSettingsStore } from "@/features/settings/store";
import type { ChatsUpdate, Session } from "@/proto";
import { onWindowFocus } from "@/lib/windowFocus";
import { clearBadge, forgetChat, notify } from "./notify";
import { primeSounds } from "./sounds";

/** How many things the chat's turn waits on the user for. */
const waiting = (session: Session | undefined) =>
    session ? Number(session.asking) + session.secrets.length : 0;

/**
 * Tells the user when a chat's turn finishes, waits on them or fails
 * (`notifications.*`). It watches the chats itself, so it sees each change
 * as it was, whatever the store has made of it since.
 */
export function useNotificationsRuntime() {
    useEffect(() => {
        const sessions = new Map<string, Session>();
        const onUpdate = (update: ChatsUpdate) => {
            switch (update.kind) {
                case "snapshot":
                    sessions.clear();
                    for (const session of update.sessions) sessions.set(session.chatId, session);
                    return;
                case "removed":
                    sessions.delete(update.id);
                    return forgetChat(update.id);
                case "session": {
                    const { session } = update;
                    const before = waiting(sessions.get(session.chatId));
                    sessions.set(session.chatId, session);
                    if (waiting(session) > before) notify("input", session.chatId);
                    return;
                }
                case "turnEnded": {
                    const { chatId, status } = update;
                    // Stopped by the user, who knows.
                    if (status === "interrupted") return;
                    if (status === "errored") return notify("error", chatId);
                    // Its queue goes on: not done yet.
                    if (sessions.get(chatId)?.queued.length) return;
                    // A chat an agent started reports to that agent, still at work.
                    const parent = useChatsStore.getState().chats.find((c) => c.id === chatId)?.parentChatId;
                    if (parent && sessions.get(parent)?.working) return;
                    return notify("done", chatId);
                }
            }
        };

        let cancelled = false;
        let unwatch: Unwatch | undefined;
        void chatsApi
            .watchChats(onUpdate)
            .then((stop) => {
                if (cancelled) stop();
                else unwatch = stop;
            })
            .catch((error: unknown) => console.warn("[notifications]", error));

        const offFocus = onWindowFocus(clearBadge);
        const offSettings = useSettingsStore.subscribe((s, before) => {
            if (!s.settings.notifications.badge && before.settings.notifications.badge) clearBadge();
        });
        const prime = () => {
            primeSounds();
            window.removeEventListener("pointerdown", prime, true);
            window.removeEventListener("keydown", prime, true);
        };
        window.addEventListener("pointerdown", prime, true);
        window.addEventListener("keydown", prime, true);

        return () => {
            cancelled = true;
            unwatch?.();
            offFocus();
            offSettings();
            window.removeEventListener("pointerdown", prime, true);
            window.removeEventListener("keydown", prime, true);
        };
    }, []);
}
