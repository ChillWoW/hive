import { checkAllOnDisk } from "@/editor";
import { gitApi } from "@/git/api";
import { git } from "@/git/store";
import type { FileDiff } from "./patch";
import { refreshDiff } from "./store";

/** What to undo: a chat's latest turn, whole or some of its files. */
export type RevertRequest = {
    chatId: string;
    /** The chat's folder, whose diffs are read again afterwards. */
    cwd: string;
    files: FileDiff[];
    /** Every file the turn changed, rather than just `files`. */
    whole: boolean;
};

/** Undoes `request` and reads everything that shows it again. */
export async function revertTurn(request: RevertRequest) {
    const paths = request.whole
        ? undefined
        : request.files.flatMap((f) => (f.oldPath ? [f.path, f.oldPath] : [f.path]));
    await gitApi.revertTurn(request.chatId, paths);
    await Promise.allSettled([
        refreshDiff({ turnOf: request.chatId }),
        refreshDiff({ cwd: request.cwd }),
        git.refresh(request.cwd)
    ]);
    checkAllOnDisk();
}
