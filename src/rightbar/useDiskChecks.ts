import { useEffect } from "react";
import { useChatsStore, workDir } from "@/chats";
import { checkAllOnDisk } from "@/editor";

const busy = (status: string | undefined) => status === "working" || status === "awaitingInput";

/**
 * Looks at open files on disk again when they may have changed: the window
 * regaining focus, or an agent's turn ending in their folder. (Zeron watches
 * the folder; this catches the same changes at those moments.)
 */
export function useDiskChecks() {
    useEffect(() => {
        const onFocus = () => checkAllOnDisk();
        window.addEventListener("focus", onFocus);
        const unsubscribe = useChatsStore.subscribe((state, previous) => {
            for (const chat of state.chats) {
                const was = previous.sessions[chat.id]?.status;
                const now = state.sessions[chat.id]?.status;
                if (busy(was) && !busy(now)) checkAllOnDisk(workDir(chat));
            }
        });
        return () => {
            window.removeEventListener("focus", onFocus);
            unsubscribe();
        };
    }, []);
}
