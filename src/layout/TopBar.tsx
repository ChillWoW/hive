import { SidebarSimpleIcon } from "@phosphor-icons/react";
import { useShortcut } from "@/keybindings";
import { isMac } from "@/lib/platform";
import { IconButton } from "@/ui";
import { cn } from "@/lib/cn";
import { useLayoutStore, useSidebarWidth } from "./store";
import { useWindowState } from "./useWindowState";
import { WindowControls } from "./WindowControls";

/**
 * How far macOS's traffic lights reach into the bar: three 12pt buttons from
 * x=20, so the last ends at 72. The window is frameless, but macOS draws them
 * over the webview anyway.
 */
const MAC_TRAFFIC_LIGHTS = "w-[72px]";

/**
 * The frameless window's title strip, laid over the top of every column:
 * draggable, the sidebar toggle at its start (its section as wide as the
 * sidebar), the window controls at its end on Windows/Linux.
 */
export function TopBar() {
    const { fullscreen } = useWindowState();
    const sidebarOpen = useLayoutStore((s) => s.sidebarOpen);
    const sidebarWidth = useSidebarWidth();
    const resizing = useLayoutStore((s) => s.resizing);
    const toggleSidebar = useLayoutStore((s) => s.toggleSidebar);
    useShortcut("toggleSidebar", toggleSidebar);

    return (
        <header
            data-tauri-drag-region
            className="absolute inset-x-0 top-0 z-10 flex h-9 select-none items-center"
        >
            <div
                data-tauri-drag-region
                style={{ width: sidebarWidth }}
                className={cn(
                    "flex h-full min-w-fit shrink-0 items-center gap-0.5 px-2",
                    !resizing && "transition-[width] duration-200 ease-out"
                )}
            >
                {isMac && !fullscreen && (
                    <div data-tauri-drag-region className={MAC_TRAFFIC_LIGHTS} />
                )}
                <IconButton
                    label="Toggle sidebar"
                    shortcut="toggleSidebar"
                    onClick={toggleSidebar}
                    aria-pressed={sidebarOpen}
                >
                    <SidebarSimpleIcon weight={sidebarOpen ? "fill" : "regular"} className="size-4" />
                </IconButton>
            </div>

            {/* An empty strip to grab the window by. */}
            <div data-tauri-drag-region className="h-full min-w-0 flex-1" />

            {!isMac && <WindowControls />}
        </header>
    );
}
