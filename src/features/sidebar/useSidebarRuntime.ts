import { useEffect } from "react";
import { activity, useChatsStore } from "@/features/chats";
import { useSidebarStore } from "./store";

/**
 * Marks a chat seen as the user leaves it, so replies that come after show
 * it unread; forgets chats that are gone.
 */
export function useSidebarRuntime() {
    useEffect(
        () =>
            useChatsStore.subscribe((s, before) => {
                const sidebar = useSidebarStore.getState();
                if (before.activeChatId && s.activeChatId !== before.activeChatId) {
                    const left = s.chats.find((c) => c.id === before.activeChatId);
                    if (left) sidebar.markSeen(left.id, activity(left));
                }
                if (s.loaded && s.chats !== before.chats) {
                    sidebar.pruneSeen(new Set(s.chats.map((c) => c.id)));
                }
            }),
        []
    );
}
