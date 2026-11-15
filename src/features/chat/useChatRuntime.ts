import { useEffect } from "react";
import { useChatsStore } from "@/features/chats/store";
import { attach } from "./store";

/** Watches the open chat's messages, following the selection. */
export function useChatRuntime() {
    const chatId = useChatsStore((s) => s.activeChatId);
    useEffect(() => {
        void attach(chatId);
    }, [chatId]);
}
