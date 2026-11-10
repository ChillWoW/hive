import { useState } from "react";
import { ArrowCircleUpIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/cn";
import { IconButton, Ring } from "@/ui";
import { isInstalling, useUpdaterStore, type UpdateState } from "./store";
import { UpdateDialog } from "./UpdateDialog";

function tooltip(state: Exclude<UpdateState, { phase: "none" }>): string {
    const version = state.update.version;
    switch (state.phase) {
        case "available":
            return `Update to ${version}`;
        case "downloading":
            return state.progress === undefined
                ? `Downloading ${version}…`
                : `Downloading ${version}… ${Math.round(state.progress * 100)}%`;
        case "installing":
            return "Restarting…";
        case "failed":
            return `Update failed: ${state.error} · Click to retry`;
    }
}

/**
 * The top bar's update icon, shown while a newer release is out. A click asks
 * first (`UpdateDialog`); nothing downloads until that's confirmed.
 */
export function UpdateButton() {
    const state = useUpdaterStore((s) => s.state);
    const [confirming, setConfirming] = useState(false);
    if (state.phase === "none") return null;

    const working = isInstalling(state);
    const failed = state.phase === "failed";
    const progress = state.phase === "downloading" ? (state.progress ?? 0) : 0;

    return (
        <>
            <IconButton
                label={failed ? "Retry update" : "Update available"}
                tooltip={tooltip(state)}
                onClick={() => {
                    if (!working) setConfirming(true);
                }}
                aria-disabled={working}
                className={cn(
                    failed ? "text-danger hover:text-danger" : "text-accent hover:text-accent",
                    working && "cursor-default"
                )}
            >
                {working ? (
                    <Ring fraction={state.phase === "installing" ? 1 : progress} />
                ) : failed ? (
                    <WarningCircleIcon className="size-4" />
                ) : (
                    <ArrowCircleUpIcon className="size-4" weight="fill" />
                )}
            </IconButton>
            <UpdateDialog open={confirming} onClose={() => setConfirming(false)} />
        </>
    );
}
