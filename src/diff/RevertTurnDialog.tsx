import { useEffect, useState } from "react";
import { errorText } from "@/git/store";
import { Button, FileIcon, Modal } from "@/ui";
import { revertTurn, type RevertRequest } from "./revert";

export type { RevertRequest } from "./revert";

const LISTED = 8;

/** Asks before undoing a turn's changes. Closed while `request` is null. */
export function RevertTurnDialog({
    request,
    onClose
}: {
    request: RevertRequest | null;
    onClose: () => void;
}) {
    const [shown, setShown] = useState(request);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        if (!request) return;
        setShown(request);
        setError(null);
    }, [request]);

    const confirm = async () => {
        if (!shown) return;
        setBusy(true);
        setError(null);
        try {
            await revertTurn(shown);
            onClose();
        } catch (e) {
            setError(errorText(e));
        } finally {
            setBusy(false);
        }
    };

    const files = shown?.files ?? [];
    const one = files.length === 1 ? files[0] : undefined;
    const added = files.filter((f) => f.status === "added").length;
    return (
        <Modal
            open={request !== null}
            onOpenChange={(open) => !open && onClose()}
            title={shown?.whole ? "Undo this turn's changes?" : "Undo this file's changes?"}
            size="sm"
        >
            <p>
                {one ? (
                    <>
                        <span className="font-medium break-all text-dark-50">{one.path}</span>{" "}
                        {one.status === "added"
                            ? "was added this turn and will be deleted."
                            : "goes back to how it was before the turn."}
                    </>
                ) : (
                    <>
                        {files.length} files go back to how they were before the turn
                        {added > 0 && `; ${added} it added will be deleted`}.
                    </>
                )}{" "}
                The agent isn't told, and this can't be undone.
            </p>
            {!one && files.length > 0 && (
                <ul className="mt-3 flex flex-col gap-1 text-xs">
                    {files.slice(0, LISTED).map((f) => (
                        <li key={f.path} className="flex min-w-0 items-center gap-2">
                            <FileIcon name={f.path.slice(f.path.lastIndexOf("/") + 1)} className="size-3.5" />
                            <span className="min-w-0 flex-1 truncate text-dark-100">{f.path}</span>
                            <span className="shrink-0 tabular-nums text-[#34d399]">+{f.additions}</span>
                            <span className="shrink-0 tabular-nums text-[#f87171]">−{f.deletions}</span>
                        </li>
                    ))}
                    {files.length > LISTED && (
                        <li className="text-dark-250">and {files.length - LISTED} more</li>
                    )}
                </ul>
            )}
            {error && (
                <p className="mt-2 text-xs break-words whitespace-pre-wrap text-danger">{error}</p>
            )}
            <div className="mt-4 flex justify-end gap-2">
                <Modal.Close render={<Button size="sm" variant="ghost" />}>Cancel</Modal.Close>
                <Button
                    size="sm"
                    variant="destructive"
                    loading={busy}
                    onClick={() => void confirm()}
                    autoFocus
                >
                    Undo changes
                </Button>
            </div>
        </Modal>
    );
}
