import { SidebarSimpleIcon } from "@phosphor-icons/react";
import { UpdateButton } from "@/features/updater";
import { useShortcut } from "@/keybindings";
import { isMac } from "@/lib/platform";
import { FolderTreeIcon, IconButton } from "@/ui";
import { DOCK_WIDTH, useLayoutStore, usePanelLayout } from "./store";
import { useTrafficLights } from "./useWindowState";
import { FakeTrafficLights } from "./FakeTrafficLights";
import { WindowControls } from "./WindowControls";

/**
 * How far macOS's traffic lights reach into the bar: three 12pt buttons from
 * x=14 (`tauri.macos.conf.json`), so the last ends near 67. The window is
 * frameless, but macOS draws them over the webview anyway.
 */
const MAC_TRAFFIC_LIGHTS = "w-[64px]";

/**
 * The frameless window's title strip, the frame's top edge (the dock is its
 * left): draggable, the sidebar toggle at its start, the update icon, the
 * right sidebar and file panel toggles and, on Windows/Linux, the window
 * controls at its end. The open chat's title heads its transcript instead.
 */
export function TopBar() {
    const trafficLights = useTrafficLights();
    const { visible } = usePanelLayout();
    const sidebarOpen = visible.left;
    const rightOpen = visible.right;
    const filesOpen = visible.files;
    const toggle = useLayoutStore((s) => s.toggle);
    const toggleSidebar = () => toggle("left");
    const toggleRightSidebar = () => toggle("right");
    const toggleFilePanel = () => toggle("files");
    useShortcut("toggleSidebar", toggleSidebar);
    useShortcut("toggleRightSidebar", toggleRightSidebar);
    useShortcut("toggleFilePanel", toggleFilePanel);

    return (
        <header data-tauri-drag-region className="flex h-9 shrink-0 select-none items-center">
            <div
                data-tauri-drag-region
                // Past the traffic lights, or centred over the dock's buttons.
                style={{ paddingLeft: trafficLights ? 8 : (DOCK_WIDTH - 24) / 2 }}
                className="flex h-full shrink-0 items-center gap-0.5 pr-2"
            >
                {trafficLights && <div data-tauri-drag-region className={MAC_TRAFFIC_LIGHTS} />}
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
            <div data-tauri-drag-region className="h-full min-w-4 flex-1" />

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

            <FakeTrafficLights />
            {!isMac && <WindowControls />}
        </header>
    );
}
