import { useEffect, useState, type ReactNode } from "react";
import { errorMessage } from "@/lib/errors";
import { Button } from "./Button";
import { Modal } from "./Modal";

/**
 * A small dialog asking before something destructive: `children` say what
 * happens, then Cancel and the `confirmLabel` button (red unless `variant`
 * says otherwise). Confirming runs `onConfirm` (the button spinning
 * meanwhile) and closes once it's done; a failure stays open with its
 * message. The confirm button has focus unless `focusCancel`, for when Enter
 * mustn't be the one that destroys.
 */
export function ConfirmDialog({
    open,
    title,
    confirmLabel,
    onConfirm,
    onClose,
    focusCancel = false,
    variant = "destructive",
    children
}: {
    open: boolean;
    title: ReactNode;
    confirmLabel: ReactNode;
    onConfirm: () => Promise<unknown>;
    onClose: () => void;
    focusCancel?: boolean;
    variant?: "destructive" | "default";
    children?: ReactNode;
}) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (open) setError(null);
    }, [open]);

    const confirm = async () => {
        setBusy(true);
        setError(null);
        try {
            await onConfirm();
            onClose();
        } catch (e) {
            setError(errorMessage(e));
        } finally {
            setBusy(false);
        }
    };

    return (
        <Modal open={open} onOpenChange={(next) => !next && onClose()}>
            <Modal.Content size="sm">
                <Modal.Header>
                    <Modal.Title>{title}</Modal.Title>
                </Modal.Header>
                <Modal.Body className="text-muted">
                    {children}
                    {error && (
                        <p className="mt-2 text-xs break-words whitespace-pre-wrap text-danger">{error}</p>
                    )}
                </Modal.Body>
                <Modal.Footer>
                    <Modal.Close render={<Button variant="ghost" autoFocus={focusCancel} />}>
                        Cancel
                    </Modal.Close>
                    <Button
                        variant={variant}
                        loading={busy}
                        onClick={() => void confirm()}
                        autoFocus={!focusCancel}
                    >
                        {confirmLabel}
                    </Button>
                </Modal.Footer>
            </Modal.Content>
        </Modal>
    );
}
