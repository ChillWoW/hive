import { ConfirmDialog, FileIcon, useLastNonNull } from "@/ui";
import { LineCounts } from "./DiffFiles";
import { revertTurn, type RevertRequest } from "./turn";

const LISTED = 8;

/** Asks before undoing a turn's changes. Closed while `request` is null. */
export function RevertTurnDialog({ request, onClose }: { request: RevertRequest | null; onClose: () => void }) {
    const shown = useLastNonNull(request);
    const files = shown?.files ?? [];
    const one = files.length === 1 ? files[0] : undefined;
    const added = files.filter((f) => f.diff.type === "new").length;

    return (
        <ConfirmDialog
            open={request !== null}
            title={shown?.whole ? "Undo this turn's changes?" : "Undo this file's changes?"}
            confirmLabel="Undo changes"
            focusCancel
            onConfirm={async () => {
                if (shown) await revertTurn(shown);
            }}
            onClose={onClose}
        >
            <p>
                {one ? (
                    <>
                        <span className="font-medium break-all text-text">{one.diff.name}</span>{" "}
                        {one.diff.type === "new"
                            ? "was added this turn and will be deleted."
                            : "goes back to how it was before the turn."}
                    </>
                ) : (
                    <>
                        {files.length} files go back to how they were before the turn
                        {added > 0 && `; the ${added} it added will be deleted`}.
                    </>
                )}{" "}
                The agent isn't told, and this can't be undone.
            </p>
            {!one && files.length > 0 && (
                <ul className="mt-3 flex flex-col gap-1 text-xs">
                    {files.slice(0, LISTED).map((f) => (
                        <li key={f.diff.name} className="flex min-w-0 items-center gap-2">
                            <FileIcon name={f.diff.name} className="size-3.5" />
                            <span className="min-w-0 flex-1 truncate text-text">{f.diff.name}</span>
                            <LineCounts additions={f.additions} deletions={f.deletions} />
                        </li>
                    ))}
                    {files.length > LISTED && <li className="text-muted">and {files.length - LISTED} more</li>}
                </ul>
            )}
        </ConfirmDialog>
    );
}
