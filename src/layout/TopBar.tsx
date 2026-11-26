import { SidebarSimpleIcon } from "@phosphor-icons/react";
import { useActiveChat } from "@/features/chats";
import { ClaudeMark } from "@/features/models";
import { UNTITLED } from "@/features/sidebar/ChatRow";
import { UpdateButton } from "@/features/updater";
import { useShortcut } from "@/keybindings";
import { isMac } from "@/lib/platform";
import { FolderTreeIcon, IconButton } from "@/ui";
import { cn } from "@/lib/cn";
import { useLayoutStore, usePanelLayout } from "./store";
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
 * sidebar), the open chat's title, the update icon, the right sidebar and file panel toggles and,
 * on Windows/Linux, the window controls at its end.
 */
export function TopBar() {
    const { fullscreen } = useWindowState();
    const chat = useActiveChat();
    const { visible, widths } = usePanelLayout();
    const sidebarOpen = visible.left;
    const rightOpen = visible.right;
    const filesOpen = visible.files;
    const sidebarWidth = widths.left;
    const resizing = useLayoutStore((s) => s.resizing);
    const toggle = useLayoutStore((s) => s.toggle);
    const toggleSidebar = () => toggle("left");
    const toggleRightSidebar = () => toggle("right");
    const toggleFilePanel = () => toggle("files");
    useShortcut("toggleSidebar", toggleSidebar);
    useShortcut("toggleRightSidebar", toggleRightSidebar);
    useShortcut("toggleFilePanel", toggleFilePanel);

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

            {/* The open chat's title after its agent's mark, then an empty
                strip to grab the window by. */}
            <div data-tauri-drag-region className="flex h-full min-w-0 flex-1 items-center gap-1.5 px-3">
                {chat && (
                    <>
                        <ClaudeMark className="size-3.5 shrink-0" />
                        <span data-tauri-drag-region className="truncate text-[13px] text-text">
                            {chat.title?.trim() || UNTITLED}
                        </span>
                    </>
                )}
                <div data-tauri-drag-region className="h-full min-w-4 flex-1" />
            </div>

            <div data-tauri-drag-region className="flex h-full shrink-0 items-center gap-0.5 px-2">
                <UpdateButton />
                <IconButton
                    label="Toggle right sidebar"
                    shortcut="toggleRightSidebar"
                    onClick={toggleRightSidebar}
                    aria-pressed={rightOpen}
                >
                    <SidebarSimpleIcon
                        weight={rightOpen ? "fill" : "regular"}
                        className="size-4 -scale-x-100"
                    />
                </IconButton>
                <IconButton
                    label="Toggle file panel"
                    shortcut="toggleFilePanel"
                    onClick={toggleFilePanel}
                    aria-pressed={filesOpen}
                >
                    <FolderTreeIcon weight={filesOpen ? "fill" : "regular"} className="size-4" />
                </IconButton>
            </div>

            {!isMac && <WindowControls />}
        </header>
    );
}
