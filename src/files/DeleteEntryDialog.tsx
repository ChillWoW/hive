import { baseName } from "@/lib/paths";
import { ConfirmDialog, useLastNonNull } from "@/ui";
import { deleteTreeEntry } from "./actions";

export type DeleteTarget = { cwd: string; path: string; dir: boolean };

/** Asks before deleting a file or folder for good. Closed while null. */
export function DeleteEntryDialog({
    target,
    onClose
}: {
    target: DeleteTarget | null;
    onClose: () => void;
}) {
    const shown = useLastNonNull(target);
    return (
        <ConfirmDialog
            open={target !== null}
            title="Delete permanently?"
            confirmLabel="Delete"
            onConfirm={async () => {
                if (shown) await deleteTreeEntry(shown.cwd, shown.path);
            }}
            onClose={onClose}
            // Delete then Enter mustn't erase a folder.
            focusCancel
        >
            <p>
                Permanently delete{" "}
                <span className="font-medium break-all text-dark-50">
                    {shown ? baseName(shown.path) : ""}
                </span>
                ?{" "}
                {shown?.dir
                    ? "Everything in the folder is deleted with it."
                    : "This can't be undone."}{" "}
                Open tabs keep their text.
            </p>
        </ConfirmDialog>
    );
}
