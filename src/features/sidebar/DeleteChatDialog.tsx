import { chats, useChatsStore } from "@/features/chats";
import type { Chat } from "@/proto";
import { ConfirmDialog, useLastNonNull } from "@/ui";
import { UNTITLED } from "./ChatRow";

/** Asks before deleting `chat`, since it can't be undone. Closed while null. */
export function DeleteChatDialog({ chat, onClose }: { chat: Chat | null; onClose: () => void }) {
    const shown = useLastNonNull(chat);
    const working = useChatsStore((s) => !!shown && !!s.working[shown.id]);

    return (
        <ConfirmDialog
            open={chat !== null}
            title="Delete chat?"
            confirmLabel="Delete"
            onConfirm={async () => {
                if (shown) await chats.remove(shown.id);
            }}
            onClose={onClose}
        >
            <p>
                <span className="font-medium text-text">{shown?.title?.trim() || UNTITLED}</span> and its
                transcript will be deleted.
                {working && " Its agent will be stopped."} This can't be undone.
            </p>
        </ConfirmDialog>
    );
}
