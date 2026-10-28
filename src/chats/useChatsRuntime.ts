import { useEffect } from "react";
import { refreshCatalogs } from "@/harnesses";
import { hydrateChats } from "./store";

/** Starts the chat list watch and loads the harness catalogs. Mount once, at the root. */
export function useChatsRuntime() {
    useEffect(() => {
        void hydrateChats();
        void refreshCatalogs();
    }, []);
}
