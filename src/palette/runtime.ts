import { useEffect } from "react";
import { useChatsStore } from "@/chats";
import { useShortcut } from "@/keybindings";
import { palette, pruneRecentChats, rememberChat } from "./store";

/** The palette's shortcut, and the chats it lists as recent. Mount once, in `App`. */
export function usePaletteRuntime() {
    useShortcut("commandPalette", palette.toggle);

    useEffect(() => {
        const { activeChatId } = useChatsStore.getState();
        if (activeChatId) rememberChat(activeChatId);
        return useChatsStore.subscribe((state, prev) => {
            if (state.activeChatId && state.activeChatId !== prev.activeChatId) {
                rememberChat(state.activeChatId);
            }
            if (state.loaded && state.chats !== prev.chats) {
                const ids = new Set(state.chats.map((c) => c.id));
                pruneRecentChats((id) => ids.has(id));
            }
        });
    }, []);
}
