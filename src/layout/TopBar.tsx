import { useWindowState } from "./useWindowState";
import { WindowControls } from "./WindowControls";
import { cn } from "@/lib/cn";
import { isMac } from "@/lib/platform";

type TopBarProps = {
    className?: string;
};

/**
 * How far the system's traffic lights reach into the top bar on macOS: three
 * 12pt buttons starting at x=20, so the last one ends at 72. The window is
 * frameless everywhere, but macOS draws those buttons anyway — over the webview —
 * so the bar starts after them.
 */
const MAC_TRAFFIC_LIGHTS = "w-[72px]";

export function TopBar({ className }: TopBarProps) {
    // Only the macOS inset cares, and only about fullscreen: the traffic lights
    // are gone there, and holding the corner open for them leaves a hole.
    const { fullscreen } = useWindowState();
    const insetForTrafficLights = isMac && !fullscreen;

    return (
        <header
            data-tauri-drag-region
            className={cn(
                "flex h-9 w-full shrink-0 select-none items-center bg-transparent",
                className
            )}
        >
            {/* A spacer rather than padding, so the corner the buttons sit in
                still drags the window like the rest of the bar. */}
            {insetForTrafficLights && (
                <div
                    data-tauri-drag-region
                    className={cn("h-full shrink-0", MAC_TRAFFIC_LIGHTS)}
                />
            )}
            {/* The empty middle is the drag handle — it has to stay in the tree even with
                nothing in it, or there is nothing wide to grab the window by. */}
            <div
                data-tauri-drag-region
                className="flex h-full min-w-0 flex-1 items-center gap-1 px-2.5"
            />
            {/* macOS draws its own; see `WindowControls`. */}
            {!isMac && <WindowControls />}
        </header>
    );
}
