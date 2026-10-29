import type { ComponentProps } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
    ArrowsInSimpleIcon,
    ArrowsOutSimpleIcon,
    MinusIcon,
    XIcon
} from "@phosphor-icons/react";
import { useWindowState } from "./useWindowState";
import { iconButtonClassName } from "@/ui";
import { cn } from "@/lib/cn";
import { isTauri } from "@/lib/platform";

type AppWindow = ReturnType<typeof getCurrentWindow>;

/** In a plain browser (`bun run dev`) there is no window to control. */
function runOnWindow(action: (w: AppWindow) => unknown) {
    if (!isTauri) return;
    void action(getCurrentWindow());
}

type ControlButtonProps = ComponentProps<"button"> & {
    label: string;
    className?: string;
};

function ControlButton({ label, className, ...props }: ControlButtonProps) {
    return (
        <button
            type="button"
            aria-label={label}
            tabIndex={-1}
            className={cn(iconButtonClassName, className)}
            {...props}
        />
    );
}

/**
 * Minimise / maximise / close, drawn in HTML because the window is frameless.
 *
 * Windows and Linux only — macOS keeps its traffic lights on a frameless window
 * and drawing these as well gives the window two sets of buttons. `TopBar` is
 * where that choice is made, next to the space held open for the real ones.
 */
export function WindowControls({ className }: { className?: string }) {
    const { maximized } = useWindowState();

    return (
        <div
            className={cn(
                "flex h-full shrink-0 items-center gap-0.5 pr-2 pl-1",
                className
            )}
        >
            <ControlButton
                label="Minimize"
                onClick={() => runOnWindow((w) => w.minimize())}
            >
                <MinusIcon className="size-4" />
            </ControlButton>
            <ControlButton
                label={maximized ? "Restore" : "Maximize"}
                onClick={() => runOnWindow((w) => w.toggleMaximize())}
            >
                {maximized ? (
                    <ArrowsInSimpleIcon className="size-4" />
                ) : (
                    <ArrowsOutSimpleIcon className="size-4" />
                )}
            </ControlButton>
            <ControlButton
                label="Close"
                className="hover:bg-danger/15 hover:text-danger active:bg-danger/25"
                onClick={() => runOnWindow((w) => w.close())}
            >
                <XIcon className="size-4" />
            </ControlButton>
        </div>
    );
}
