import { useEffect, useSyncExternalStore } from "react";
import { refreshCatalogs } from "@/harnesses";
import { chats, hydrateChats, isUnseen, useChatsStore } from "./store";

/** Starts the chat list watch and loads the harness catalogs. Mount once, at the root. */
export function useChatsRuntime() {
    useEffect(() => {
        void hydrateChats();
        void refreshCatalogs();
    }, []);
    useMarkActiveSeen();
}

function subscribeFocus(onChange: () => void) {
    window.addEventListener("focus", onChange);
    window.addEventListener("blur", onChange);
    return () => {
        window.removeEventListener("focus", onChange);
        window.removeEventListener("blur", onChange);
    };
}

/**
 * Marks the open chat seen whenever it has news, while the window has focus:
 * a turn that finishes in the background keeps its dot until you look.
 */
function useMarkActiveSeen() {
    const focused = useSyncExternalStore(subscribeFocus, () => document.hasFocus());
    const chatId = useChatsStore((s) => s.activeChatId);
    const unseen = useChatsStore((s) => {
        const chat = s.chats.find((c) => c.id === s.activeChatId);
        return chat ? isUnseen(chat) : false;
    });
    useEffect(() => {
        if (chatId && unseen && focused) {
            chats.markSeen(chatId).catch(() => {});
        }
    }, [chatId, unseen, focused]);
}
