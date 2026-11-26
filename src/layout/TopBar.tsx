import { ArrowLeftIcon, ArrowRightIcon, SidebarSimpleIcon } from "@phosphor-icons/react";
import { useEffect } from "react";
import { history, useCanGo } from "@/features/chats";
import { TabStrip } from "@/features/tabs";
import { UpdateButton } from "@/features/updater";
import { useShortcut, type ActionId } from "@/keybindings";
import { isMac } from "@/lib/platform";
import { FolderTreeIcon, IconButton } from "@/ui";
import { usePlacement, type Side } from "./placement";
import { DOCK_WIDTH, useLayoutStore, usePanelLayout, type Panel } from "./store";
import { useTrafficLights } from "./useWindowState";
import { FakeTrafficLights } from "./FakeTrafficLights";
import { WindowControls } from "./WindowControls";

/**
 * How far macOS's traffic lights reach into the bar: three 12pt buttons from
 * x=14 (`tauri.macos.conf.json`), so the last ends near 67. The window is
 * frameless, but macOS draws them over the webview anyway.
 */
const MAC_TRAFFIC_LIGHTS = "w-[64px]";

/** A top bar button's inset that centres it over the dock below. */
const OVER_DOCK = (DOCK_WIDTH - 24) / 2;

const TOGGLES: Record<Panel, { label: string; shortcut: ActionId }> = {
    chats: { label: "Toggle sidebar", shortcut: "toggleSidebar" },
    tabs: { label: "Toggle tabs panel", shortcut: "toggleRightSidebar" },
    files: { label: "Toggle file panel", shortcut: "toggleFilePanel" }
};

/**
 * The frameless window's title strip, the frame's top edge (the dock is its
 * side): draggable, each panel's toggle at the end of the side the panel is
 * on, the open chats' tabs between, the update icon and, on Windows/Linux,
 * the window controls at its end.
 */
export function TopBar() {
    const trafficLights = useTrafficLights();
    const placement = usePlacement();
    const toggle = useLayoutStore((s) => s.toggle);
    useShortcut("toggleSidebar", () => toggle("chats"));
    useShortcut("toggleRightSidebar", () => toggle("tabs"));
    useShortcut("toggleFilePanel", () => toggle("files"));
    const dockLeft = placement.dock === "left";

    return (
        <header data-tauri-drag-region className="flex h-9 shrink-0 select-none items-center">
            <div
                data-tauri-drag-region
                // Past the traffic lights, or centred over the dock's buttons.
                style={{ paddingLeft: !trafficLights && dockLeft ? OVER_DOCK : 8 }}
                className="flex h-full shrink-0 items-center gap-0.5 pr-2"
            >
                {trafficLights && <div data-tauri-drag-region className={MAC_TRAFFIC_LIGHTS} />}
                {placement.left.map((panel) => (
                    <PanelToggle key={panel} panel={panel} side="left" />
                ))}
                <HistoryButtons />
            </div>

            {/* The open chats; past them, an empty strip to grab the window by. */}
            <TabStrip />

            <div
                data-tauri-drag-region
                // With no window controls after it, centred over a dock on the right.
                style={{ paddingRight: isMac && !dockLeft ? OVER_DOCK : 8 }}
                className="flex h-full shrink-0 items-center gap-0.5 pl-2"
            >
                <UpdateButton />
                {placement.right.map((panel) => (
                    <PanelToggle key={panel} panel={panel} side="right" />
                ))}
            </div>

            <FakeTrafficLights />
            {!isMac && <WindowControls />}
        </header>
    );
}

/**
 * Back and forward through the chats the main pane showed, also on their
 * shortcuts and the mouse's side buttons.
 */
function HistoryButtons() {
    const canBack = useCanGo(-1);
    const canForward = useCanGo(1);
    useShortcut("goBack", history.back);
    useShortcut("goForward", history.forward);
    useEffect(() => {
        // Buttons 3 and 4: a mouse's back and forward side buttons.
        const onMouseUp = (event: MouseEvent) => {
            if (event.button !== 3 && event.button !== 4) return;
            event.preventDefault();
            if (event.button === 3) history.back();
            else history.forward();
        };
        // Without this the webview would run its own (empty) history.
        const swallow = (event: MouseEvent) => {
            if (event.button === 3 || event.button === 4) event.preventDefault();
        };
        window.addEventListener("mouseup", onMouseUp);
        window.addEventListener("mousedown", swallow);
        return () => {
            window.removeEventListener("mouseup", onMouseUp);
            window.removeEventListener("mousedown", swallow);
        };
    }, []);

    return (
        <>
            <IconButton label="Go back" shortcut="goBack" onClick={history.back} disabled={!canBack}>
                <ArrowLeftIcon className="size-4" />
            </IconButton>
            <IconButton
                label="Go forward"
                shortcut="goForward"
                onClick={history.forward}
                disabled={!canForward}
            >
                <ArrowRightIcon className="size-4" />
            </IconButton>
        </>
    );
}

function PanelToggle({ panel, side }: { panel: Panel; side: Side }) {
    const shown = usePanelLayout().visible[panel];
    const toggle = useLayoutStore((s) => s.toggle);
    const { label, shortcut } = TOGGLES[panel];
    const weight = shown ? "fill" : "regular";

    return (
        <IconButton
            label={label}
            shortcut={shortcut}
            onClick={() => toggle(panel)}
            aria-pressed={shown}
        >
            {panel === "files" ? (
                <FolderTreeIcon weight={weight} className="size-4" />
            ) : (
                <SidebarSimpleIcon
                    weight={weight}
                    className={side === "right" ? "size-4 -scale-x-100" : "size-4"}
                />
            )}
        </IconButton>
    );
}
