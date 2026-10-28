import { useEffect, useState } from "react";
import type { GitBranch } from "@/proto";
import { Button, Input, Modal } from "@/ui";
import { errorText, git } from "./store";

/** Keeps the last non-null value while a dialog animates out. */
function useShown<T>(value: T | null): T | null {
    const [shown, setShown] = useState(value);
    useEffect(() => {
        if (value !== null) setShown(value);
    }, [value]);
    return value ?? shown;
}

/** Names a branch off `from` and switches to it. Closed while `from` is null. */
export function NewBranchDialog({
    cwd,
    from,
    onClose
}: {
    cwd: string;
    from: string | null;
    onClose: () => void;
}) {
    const shown = useShown(from);
    const [name, setName] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        if (from === null) return;
        setName("");
        setError(null);
    }, [from]);

    const create = async () => {
        const trimmed = name.trim();
        if (!shown || !trimmed) return;
        setBusy(true);
        setError(null);
        try {
            await git.createBranch(cwd, trimmed, shown);
            onClose();
        } catch (e) {
            setError(errorText(e));
        } finally {
            setBusy(false);
        }
    };

    return (
        <Modal
            open={from !== null}
            onOpenChange={(open) => !open && onClose()}
            title="New branch"
            size="sm"
        >
            <form
                onSubmit={(event) => {
                    event.preventDefault();
                    void create();
                }}
            >
                <p>
                    Branches off <span className="font-medium text-dark-50">{shown}</span>{" "}
                    and switches to it.
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
                    spellCheck={false}
                    autoComplete="off"
                    disabled={busy}
                    invalid={error !== null}
                    className="mt-3 w-full text-xs"
                />
                {error && (
                    <p className="mt-2 text-xs break-words whitespace-pre-wrap text-danger">
                        {error}
                    </p>
                )}
                <div className="mt-4 flex justify-end gap-2">
                    <Modal.Close render={<Button type="button" size="sm" variant="ghost" />}>
                        Cancel
                    </Modal.Close>
                    <Button
                        type="submit"
                        size="sm"
                        variant="primary"
                        loading={busy}
                        disabled={!name.trim()}
                    >
                        Create branch
                    </Button>
                </div>
            </form>
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
    const shown = useShown(branch);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        if (branch) setError(null);
    }, [branch]);

    const confirm = async () => {
        if (!shown) return;
        setBusy(true);
        setError(null);
        try {
            await git.deleteBranch(cwd, shown.name);
            onClose();
        } catch (e) {
            setError(errorText(e));
        } finally {
            setBusy(false);
        }
    };

    return (
        <Modal
            open={branch !== null}
            onOpenChange={(open) => !open && onClose()}
            title="Delete branch?"
            size="sm"
        >
            <p>
                <span className="font-medium break-all text-dark-50">{shown?.name}</span> will
                be deleted.
                {shown && !shown.merged && (
                    <>
                        {" "}
                        It has commits that aren't in{" "}
                        <span className="font-medium break-all text-dark-50">{into}</span>;
                        they'll be lost.
                    </>
                )}{" "}
                This can't be undone.
            </p>
            {error && (
                <p className="mt-2 text-xs break-words whitespace-pre-wrap text-danger">
                    {error}
                </p>
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
                    Delete
                </Button>
            </div>
        </Modal>
    );
}
