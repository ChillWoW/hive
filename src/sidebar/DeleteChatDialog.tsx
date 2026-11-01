import { chats, useSession } from "@/chats";
import { useGitRepo } from "@/git";
import type { Chat } from "@/proto";
import { useSetting } from "@/settings/store";
import { ConfirmDialog, useLastNonNull } from "@/ui";
import { UNTITLED } from "./ChatRow";

/** Asks before deleting `chat`, since it can't be undone. Closed while null. */
export function DeleteChatDialog({
    chat,
    onClose
}: {
    chat: Chat | null;
    onClose: () => void;
}) {
    const shown = useLastNonNull(chat);
    const running = useSession(shown?.id ?? null) !== undefined;
    const worktree = shown?.worktree;
    const changes = useGitRepo(worktree?.path)?.repo?.changes ?? 0;
    const deleteBranch = useSetting("worktrees", "deleteBranch").value;

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
                <span className="font-medium text-dark-50">
                    {shown?.title?.trim() || UNTITLED}
                </span>{" "}
                and its transcript will be deleted.
                {running && " Its agent will be stopped."} This can't be undone.
            </p>
            {worktree && (
                <p className="mt-2">
                    {deleteBranch
                        ? "Its worktree and branch "
                        : "Its worktree is removed too; the branch "}
                    <span className="font-medium break-all text-dark-50">{worktree.branch}</span>{" "}
                    {deleteBranch ? "are deleted too." : "is kept."}
                    {changes > 0 && (
                        <span className="text-warning">
                            {" "}
                            {changes === 1
                                ? "1 file with uncommitted changes"
                                : `${changes} files with uncommitted changes`}{" "}
                            in it will be lost.
                        </span>
                    )}
                </p>
            )}
        </ConfirmDialog>
    );
}
