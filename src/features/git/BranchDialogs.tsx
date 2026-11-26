import { useState } from "react";
import type { GitBranch } from "@/proto";
import { Button, ConfirmDialog, Input, Modal, useLastNonNull } from "@/ui";
import { git, useGitAction } from "./store";

/** Names a branch off `from` and switches to it. Closed while `from` is null. */
export function NewBranchDialog({ cwd, from, onClose }: { cwd: string; from: string | null; onClose: () => void }) {
    const shown = useLastNonNull(from);
    const [name, setName] = useState("");
    const { busy, error, setError, run } = useGitAction();

    const create = async () => {
        const trimmed = name.trim();
        if (!shown || !trimmed) return;
        if (await run(() => git.createBranch(cwd, trimmed, shown))) onClose();
    };

    return (
        <Modal
            open={from !== null}
            onOpenChange={(next) => !next && onClose()}
            // Blank for the next time, once it's out of sight.
            onOpenChangeComplete={(next) => {
                if (next) return;
                setName("");
                setError(null);
            }}
        >
            <Modal.Content size="sm">
                <form
                    onSubmit={(event) => {
                        event.preventDefault();
                        void create();
                    }}
                >
                    <Modal.Header>
                        <Modal.Title>New branch</Modal.Title>
                    </Modal.Header>
                    <Modal.Body className="text-muted">
                        <p>
                            Branches off <span className="font-medium break-all text-text">{shown}</span> and
                            switches to it.
                        </p>
                        <Input
                            autoFocus
                            value={name}
                            onChange={(event) => {
                                setName(event.target.value);
                                setError(null);
                            }}
                            placeholder="feat/my-branch"
                            aria-label="Branch name"
                            aria-invalid={error !== null || undefined}
                            spellCheck={false}
                            autoComplete="off"
                            disabled={busy}
                            className="mt-3 w-full"
                        />
                        {error && <p className="mt-2 text-xs break-words whitespace-pre-wrap text-danger">{error}</p>}
                    </Modal.Body>
                    <Modal.Footer>
                        <Modal.Close render={<Button type="button" variant="ghost" />}>Cancel</Modal.Close>
                        <Button type="submit" loading={busy} disabled={!name.trim()}>
                            Create branch
                        </Button>
                    </Modal.Footer>
                </form>
            </Modal.Content>
        </Modal>
    );
}

/**
 * Asks before deleting `branch`, warning when it has commits that aren't in
 * the checked-out branch (`into`), since those are lost. Closed while null.
 */
export function DeleteBranchDialog({
    cwd,
    branch,
    into,
    onClose
}: {
    cwd: string;
    branch: GitBranch | null;
    into: string;
    onClose: () => void;
}) {
    const shown = useLastNonNull(branch);
    return (
        <ConfirmDialog
            open={branch !== null}
            title="Delete branch?"
            confirmLabel="Delete"
            onConfirm={async () => {
                if (shown) await git.deleteBranch(cwd, shown.name);
            }}
            onClose={onClose}
        >
            <p>
                <span className="font-medium break-all text-text">{shown?.name}</span> will be deleted.
                {shown && !shown.merged && (
                    <>
                        {" "}
                        It has commits that aren't in <span className="font-medium break-all text-text">{into}</span>;
                        they'll be lost.
                    </>
                )}{" "}
                This can't be undone.
            </p>
        </ConfirmDialog>
    );
}
