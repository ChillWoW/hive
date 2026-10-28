import { useEffect } from "react";
import { hydrateChats } from "./store";

/** Starts the chat list watch. Mount once, at the root. */
export function useChatsRuntime() {
    useEffect(() => {
        void hydrateChats();
    }, []);
}
