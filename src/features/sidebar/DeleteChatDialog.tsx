import { chats, useChatsStore, useWorking } from "@/features/chats";
import { useGitRepo } from "@/features/git";
import { useSettingsStore } from "@/features/settings";
import type { Chat } from "@/proto";
import { ConfirmDialog, useLastNonNull } from "@/ui";
import { UNTITLED } from "./ChatRow";

/**
 * Asks before deleting `chat`, since it can't be undone. Closed while null.
 * A worktree chat's worktree goes with it (its uncommitted changes too); its
 * branch is kept unless `worktrees.deleteBranch` is on.
 */
export function DeleteChatDialog({ chat, onClose }: { chat: Chat | null; onClose: () => void }) {
    const shown = useLastNonNull(chat);
    const working = useWorking(shown?.id);
    // A handoff shares the worktree: it stays while another chat works in it.
    const shared = useChatsStore((s) =>
        s.chats.some((c) => c.id !== shown?.id && !!c.worktree && c.worktree.root === shown?.worktree?.root)
    );
    const worktree = shared ? undefined : shown?.worktree;
    const changes = useGitRepo(chat ? worktree?.path : null)?.changes ?? 0;
    const deleteBranch = useSettingsStore((s) => s.settings.worktrees.deleteBranch);

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
                <span className="font-medium text-text">{shown?.title?.trim() || UNTITLED}</span>
                {worktree ? (deleteBranch ? " and its worktree and branch" : " and its worktree") : ""} will be
                deleted for good{working || changes > 0 ? "." : ""}
                {working && " Its agent will be stopped."}
                {changes > 0 && (
                    <span className="text-warning">
                        {" "}
                        {changes === 1 ? "1 uncommitted file is" : `${changes} uncommitted files are`} lost with it.
                    </span>
                )}
            </p>
        </ConfirmDialog>
    );
}
