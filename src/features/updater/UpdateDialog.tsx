import { ConfirmDialog } from "@/ui";
import { install, useUpdaterStore } from "./store";

/**
 * Asks before installing: the restart stops any running agents. Confirming
 * starts the install and closes; its progress shows on the top bar's icon.
 */
export function UpdateDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
    const state = useUpdaterStore((s) => s.state);
    const version = state.phase === "none" ? null : state.update.version;

    return (
        <ConfirmDialog
            open={open}
            onClose={onClose}
            title={version ? `Update to Outcode ${version}?` : "Update Outcode?"}
            confirmLabel="Update"
            variant="default"
            onConfirm={async () => void install()}
        >
            <p className="text-sm text-muted">Outcode will restart. Running agents are stopped.</p>
        </ConfirmDialog>
    );
}
