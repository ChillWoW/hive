import { useEffect } from "react";
import { chatApi } from "./api";
import { useChatStore } from "./store";

/** Feeds runs' events into the chat store. */
export function useChatRuntime() {
    useEffect(() => {
        let cancelled = false;
        let unlisten: (() => void) | undefined;
        void chatApi
            .onEvent(({ chatId, event }) => useChatStore.getState().apply(chatId, event))
            .then((stop) => {
                if (cancelled) stop();
                else unlisten = stop;
            });
        return () => {
            cancelled = true;
            unlisten?.();
        };
    }, []);
}
