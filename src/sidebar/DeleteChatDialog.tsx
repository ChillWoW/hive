import { useEffect, useState } from "react";
import { chats, useSession } from "@/chats";
import { useGitRepo } from "@/git";
import type { Chat } from "@/proto";
import { useSetting } from "@/settings/store";
import { Button, Modal } from "@/ui";
import { UNTITLED } from "./ChatRow";

/** Asks before deleting `chat`, since it can't be undone. Closed while null. */
export function DeleteChatDialog({
    chat,
    onClose
}: {
    chat: Chat | null;
    onClose: () => void;
}) {
    // Kept while the dialog animates out.
    const [shown, setShown] = useState(chat);
    useEffect(() => {
        if (chat) setShown(chat);
    }, [chat]);
    const running = useSession(shown?.id ?? null) !== undefined;
    const worktree = shown?.worktree;
    const changes = useGitRepo(worktree?.path)?.repo?.changes ?? 0;
    const deleteBranch = useSetting("worktrees", "deleteBranch").value;
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    useEffect(() => setError(null), [chat]);

    const confirm = async () => {
        if (!shown) return;
        setBusy(true);
        try {
            await chats.remove(shown.id);
            onClose();
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(false);
        }
    };

    return (
        <Modal
            open={chat !== null}
            onOpenChange={(open) => !open && onClose()}
            title="Delete chat?"
            size="sm"
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
            {error && <p className="mt-2 text-xs text-danger">{error}</p>}
            <div className="mt-4 flex justify-end gap-2">
                <Modal.Close render={<Button size="sm" variant="ghost" />}>
                    Cancel
                </Modal.Close>
                <Button
                    size="sm"
                    variant="destructive"
                    loading={busy}
                    onClick={() => void confirm()}
                    autoFocus
                >
                    Delete
                </Button>
            </div>
        </Modal>
    );
}
