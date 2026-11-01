import { ConfirmDialog, FileIcon, useLastNonNull } from "@/ui";
import { LineCounts } from "./DiffFiles";
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
    const shown = useLastNonNull(request);
    const files = shown?.files ?? [];
    const one = files.length === 1 ? files[0] : undefined;
    const added = files.filter((f) => f.status === "added").length;
    return (
        <ConfirmDialog
            open={request !== null}
            title={shown?.whole ? "Undo this turn's changes?" : "Undo this file's changes?"}
            confirmLabel="Undo changes"
            onConfirm={async () => {
                if (shown) await revertTurn(shown);
            }}
            onClose={onClose}
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
                            <FileIcon name={f.path} className="size-3.5" />
                            <span className="min-w-0 flex-1 truncate text-dark-100">{f.path}</span>
                            <LineCounts additions={f.additions} deletions={f.deletions} className="shrink-0" />
                        </li>
                    ))}
                    {files.length > LISTED && (
                        <li className="text-dark-250">and {files.length - LISTED} more</li>
                    )}
                </ul>
            )}
        </ConfirmDialog>
    );
}
