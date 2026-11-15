import { useEffect } from "react";
import { chatsApi, type Unwatch } from "./api";
import { useChatsStore } from "./store";

/** Keeps the chat list in sync with the backend's. */
export function useChatsRuntime() {
    useEffect(() => {
        let cancelled = false;
        let unwatch: Unwatch | undefined;
        void chatsApi
            .watchChats((update) => useChatsStore.getState().apply(update))
            .then((stop) => {
                if (cancelled) stop();
                else unwatch = stop;
            })
            .catch((error: unknown) => console.warn("[chats]", error));
        return () => {
            cancelled = true;
            unwatch?.();
        };
    }, []);
}
