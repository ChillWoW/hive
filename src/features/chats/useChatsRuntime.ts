import { useEffect } from "react";
import { useComposerStore } from "@/features/composer/store";
import { refreshCatalog } from "@/features/models";
import { chatsApi, type Unwatch } from "./api";
import { useChatsStore } from "./store";

/**
 * Keeps the chat list in sync with the backend's, fetches the model
 * catalog, and drops the drafts of chats that are gone.
 */
export function useChatsRuntime() {
    useEffect(() => {
        void refreshCatalog();
        let cancelled = false;
        let unwatch: Unwatch | undefined;
        void chatsApi
            .watchChats((update) => useChatsStore.getState().apply(update))
            .then((stop) => {
                if (cancelled) stop();
                else unwatch = stop;
            })
            .catch((error: unknown) => console.warn("[chats]", error));
        const unsubscribe = useChatsStore.subscribe((s, before) => {
            if (s.loaded && s.chats !== before.chats) {
                useComposerStore.getState().pruneDrafts(new Set(s.chats.map((c) => c.id)));
            }
        });
        return () => {
            cancelled = true;
            unwatch?.();
            unsubscribe();
        };
    }, []);
}
