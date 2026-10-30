import { useEffect, useState } from "react";
import { Button, Modal } from "@/ui";
import { deleteTreeEntry } from "./actions";
import { nameOf } from "./tree";

export type DeleteTarget = { cwd: string; path: string; dir: boolean };

/** Asks before deleting a file or folder for good (zeron's tree delete). Closed while null. */
export function DeleteEntryDialog({
    target,
    onClose
}: {
    target: DeleteTarget | null;
    onClose: () => void;
}) {
    // Kept while the dialog animates out.
    const [shown, setShown] = useState(target);
    useEffect(() => {
        if (target) setShown(target);
    }, [target]);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    useEffect(() => setError(null), [target]);

    const confirm = async () => {
        if (!shown) return;
        setBusy(true);
        try {
            await deleteTreeEntry(shown.cwd, shown.path);
            onClose();
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(false);
        }
    };

    return (
        <Modal
            open={target !== null}
            onOpenChange={(open) => !open && onClose()}
            title="Delete permanently?"
            size="sm"
        >
            <p>
                Permanently delete{" "}
                <span className="font-medium break-all text-dark-50">
                    {shown ? nameOf(shown.path) : ""}
                </span>
                ?{" "}
                {shown?.dir
                    ? "Everything in the folder is deleted with it."
                    : "This can't be undone."}{" "}
                Open tabs keep their text.
            </p>
            {error && <p className="mt-2 text-xs text-danger">{error}</p>}
            <div className="mt-4 flex justify-end gap-2">
                {/* Cancel has focus, as in zeron: Delete then Enter mustn't erase a folder. */}
                <Modal.Close render={<Button size="sm" variant="ghost" autoFocus />}>
                    Cancel
                </Modal.Close>
                <Button
                    size="sm"
                    variant="destructive"
                    loading={busy}
                    onClick={() => void confirm()}
                >
                    Delete
                </Button>
            </div>
        </Modal>
    );
}
