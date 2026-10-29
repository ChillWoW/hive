import { ArrowCircleUpIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { Ring } from "@/chat/Ring";
import { cn } from "@/lib/cn";
import { Tooltip } from "@/ui";
import { install, useUpdaterStore, type UpdateState } from "./store";

function label(state: Exclude<UpdateState, { phase: "none" }>): string {
    switch (state.phase) {
        case "available":
            return "Update available";
        case "downloading":
            return state.progress === undefined
                ? "Downloading…"
                : `Downloading… ${Math.round(state.progress * 100)}%`;
        case "installing":
            return "Restarting…";
        case "failed":
            return "Update failed · Retry";
    }
}

function hint(state: Exclude<UpdateState, { phase: "none" }>): string {
    if (state.phase === "failed") return state.error;
    if (state.phase === "available") return "Install and restart Hive";
    return `Installing Hive ${state.update.version}`;
}

/**
 * The sidebar's footer entry above Settings, shown while a newer release is
 * out. Nothing downloads until it's clicked: then download, install, restart.
 */
export function UpdateButton() {
    const state = useUpdaterStore((s) => s.state);
    if (state.phase === "none") return null;

    const working = state.phase === "downloading" || state.phase === "installing";
    const failed = state.phase === "failed";
    const progress = state.phase === "downloading" ? (state.progress ?? 0) : 0;

    return (
        <Tooltip>
            <Tooltip.Trigger
                render={
                    <button
                        type="button"
                        onClick={() => void install()}
                        disabled={working}
                        className={cn(
                            "relative flex h-8 w-full items-center gap-2 overflow-hidden rounded-md px-2 text-left text-xs",
                            "transition-colors duration-150",
                            failed
                                ? "text-danger hover:bg-dark-800"
                                : "bg-info/10 text-info hover:bg-info/15 active:bg-info/20",
                            working && "cursor-default hover:bg-info/10"
                        )}
                    >
                        {state.phase === "downloading" && (
                            <span
                                aria-hidden
                                style={{ width: `${progress * 100}%` }}
                                className="absolute inset-y-0 left-0 bg-info/15 transition-[width] duration-200"
                            />
                        )}
                        {working ? (
                            <span className="relative">
                                <Ring fraction={state.phase === "installing" ? 1 : progress} />
                            </span>
                        ) : failed ? (
                            <WarningCircleIcon className="relative size-4 shrink-0" />
                        ) : (
                            <ArrowCircleUpIcon className="relative size-4 shrink-0" weight="fill" />
                        )}
                        <span className="relative min-w-0 flex-1 truncate">{label(state)}</span>
                        {!failed && (
                            <span className="relative shrink-0 text-info/70 tabular-nums">
                                v{state.update.version}
                            </span>
                        )}
                    </button>
                }
            />
            <Tooltip.Content side="top">{hint(state)}</Tooltip.Content>
        </Tooltip>
    );
}
