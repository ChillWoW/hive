import {
    SIDEBAR_WIDTH,
    useLayoutStore,
    usePanelLayout
} from "@/stores/useLayoutStore";
import { useWindowState } from "./useWindowState";
import { WindowControls } from "./WindowControls";
import { chats, useChatsStore } from "@/chats";
import { composer } from "@/composer";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { TabStrip } from "@/rightbar";
import { HarnessIcon } from "@/harnesses";
import { useShortcut } from "@/keybindings";
import { cn } from "@/lib/cn";
import { isMac } from "@/lib/platform";
import type { HarnessId } from "@/proto";
import { Button, FolderTreeIcon, Tooltip } from "@/ui";
import {
    ArrowLeftIcon,
    ArrowRightIcon,
    PlusIcon,
    SidebarSimpleIcon
} from "@phosphor-icons/react";

type TopBarProps = {
    title?: string;
    /** The open chat's harness, marked before the title. */
    harness?: HarnessId;
    className?: string;
};

/**
 * How far the system's traffic lights reach into the top bar on macOS: three
 * 12pt buttons starting at x=20, so the last one ends at 72. The window is
 * frameless everywhere, but macOS draws those buttons anyway — over the webview —
 * so the bar starts after them.
 */
const MAC_TRAFFIC_LIGHTS = "w-[72px]";

/** The mouse's side buttons (3 back, 4 forward) step through chat history. */
function useMouseNavigation() {
    useEffect(() => {
        const onMouseUp = (event: MouseEvent) => {
            if (event.button === 3) chats.goBack();
            else if (event.button === 4) chats.goForward();
            else return;
            event.preventDefault();
        };
        window.addEventListener("mouseup", onMouseUp);
        return () => window.removeEventListener("mouseup", onMouseUp);
    }, []);
}

export function TopBar({ title, harness, className }: TopBarProps) {
    const { fullscreen } = useWindowState();
    const insetForTrafficLights = isMac && !fullscreen;

    // What's shown, not what's open: a panel hidden for room reads as closed.
    const layout = usePanelLayout();
    const {
        sidebar: open,
        files: filePanelOpen,
        right: rightOpen
    } = layout.visible;
    const resizing = useLayoutStore((state) => state.resizing);

    // The right sidebar's tabs sit in this bar above it. The panel toggles and
    // window controls keep the corner: over the file panel while it's wide
    // enough, else they take the end of the tabs' room.
    const trailing = useRef<HTMLDivElement>(null);
    const [trailingWidth, setTrailingWidth] = useState(0);
    useLayoutEffect(() => {
        const el = trailing.current;
        if (!el) return;
        const observer = new ResizeObserver(() => setTrailingWidth(el.offsetWidth));
        observer.observe(el);
        return () => observer.disconnect();
    }, []);
    const tabsWidth = Math.max(0, layout.right - Math.max(0, trailingWidth - layout.files));
    const tabsGap = Math.max(0, layout.files - trailingWidth);
    const toggleSidebar = useLayoutStore((state) => state.toggleSidebar);
    const toggleFilePanel = useLayoutStore((state) => state.toggleFilePanel);
    const toggleRightSidebar = useLayoutStore(
        (state) => state.toggleRightSidebar
    );
    const newChat = () => {
        chats.select(null);
        composer.focus();
    };
    useShortcut("toggleSidebar", toggleSidebar);
    useShortcut("newChat", newChat);

    const canGoBack = useChatsStore((s) => s.back.length > 0);
    const canGoForward = useChatsStore((s) => s.forward.length > 0);
    useShortcut("goBack", chats.goBack);
    useShortcut("goForward", chats.goForward);
    useMouseNavigation();

    return (
        <header
            data-tauri-drag-region
            className={cn(
                "absolute inset-x-0 top-0 z-10 flex h-9 select-none items-center bg-transparent",
                className
            )}
        >
            <div
                data-tauri-drag-region
                style={{ width: open ? SIDEBAR_WIDTH : 0 }}
                className="relative flex h-full min-w-fit shrink-0 items-center transition-[width]"
            >
                {insetForTrafficLights && (
                    <div
                        data-tauri-drag-region
                        className={MAC_TRAFFIC_LIGHTS}
                    />
                )}

                <div
                    data-tauri-drag-region
                    className="flex h-full items-center gap-0.5 px-2"
                >
                    <Tooltip>
                        <Tooltip.Trigger
                            render={
                                <Button
                                    variant="ghost"
                                    onClick={toggleSidebar}
                                    aria-label="Toggle sidebar"
                                    className="p-0 size-6"
                                >
                                    <SidebarSimpleIcon
                                        weight={open ? "fill" : "regular"}
                                        className="size-4"
                                    />
                                </Button>
                            }
                        />
                        <Tooltip.Content side="bottom" shortcut="toggleSidebar">
                            Toggle sidebar
                        </Tooltip.Content>
                    </Tooltip>

                    <Tooltip>
                        <Tooltip.Trigger
                            render={
                                <Button
                                    variant="ghost"
                                    aria-label="Back"
                                    onClick={chats.goBack}
                                    disabled={!canGoBack}
                                    className="p-0 size-6"
                                >
                                    <ArrowLeftIcon className="size-4" />
                                </Button>
                            }
                        />
                        <Tooltip.Content side="bottom" shortcut="goBack">
                            Back
                        </Tooltip.Content>
                    </Tooltip>

                    <Tooltip>
                        <Tooltip.Trigger
                            render={
                                <Button
                                    variant="ghost"
                                    aria-label="Forward"
                                    onClick={chats.goForward}
                                    disabled={!canGoForward}
                                    className="p-0 size-6"
                                >
                                    <ArrowRightIcon className="size-4" />
                                </Button>
                            }
                        />
                        <Tooltip.Content side="bottom" shortcut="goForward">
                            Forward
                        </Tooltip.Content>
                    </Tooltip>

                    <Tooltip>
                        <Tooltip.Trigger
                            render={
                                <Button
                                    variant="ghost"
                                    aria-label="New chat"
                                    onClick={newChat}
                                    className="p-0 size-6"
                                >
                                    <PlusIcon className="size-4" />
                                </Button>
                            }
                        />
                        <Tooltip.Content side="bottom" shortcut="newChat">
                            New chat
                        </Tooltip.Content>
                    </Tooltip>
                </div>
            </div>

            <div
                data-tauri-drag-region
                className="flex h-full min-w-0 flex-1 items-center gap-1 px-3"
            >
                {harness && (
                    <HarnessIcon
                        harness={harness}
                        className="size-3.5 shrink-0"
                    />
                )}
                {title && (
                    <span className="truncate text-[13px] text-dark-50">
                        {title}
                    </span>
                )}
                {/* Spacer: an empty strip you can grab to drag the window. */}
                <div data-tauri-drag-region className="h-full flex-1" />
            </div>

            <div
                data-tauri-drag-region
                inert={!rightOpen}
                style={{ width: tabsWidth }}
                className={cn(
                    "flex h-full shrink-0 overflow-hidden",
                    !resizing && "transition-[width]"
                )}
            >
                <TabStrip />
            </div>
            <div
                data-tauri-drag-region
                style={{ width: tabsGap }}
                className={cn("h-full shrink-0", !resizing && "transition-[width]")}
            />

            <div ref={trailing} className="flex h-full shrink-0 items-center">
                <div data-tauri-drag-region className="flex h-full items-center gap-0.5 px-2">
                    <Tooltip>
                        <Tooltip.Trigger
                            render={
                                <Button
                                    variant="ghost"
                                    onClick={toggleFilePanel}
                                    aria-label="Toggle file panel"
                                    aria-pressed={filePanelOpen}
                                    className="p-0 size-6"
                                >
                                    <FolderTreeIcon
                                        weight={
                                            filePanelOpen ? "fill" : "regular"
                                        }
                                        className="size-4"
                                    />
                                </Button>
                            }
                        />
                        <Tooltip.Content side="bottom">
                            Toggle file panel
                        </Tooltip.Content>
                    </Tooltip>

                    <Tooltip>
                        <Tooltip.Trigger
                            render={
                                <Button
                                    variant="ghost"
                                    onClick={toggleRightSidebar}
                                    aria-label="Toggle right sidebar"
                                    aria-pressed={rightOpen}
                                    className="p-0 size-6"
                                >
                                    <SidebarSimpleIcon
                                        weight={rightOpen ? "fill" : "regular"}
                                        className="size-4 -scale-x-100"
                                    />
                                </Button>
                            }
                        />
                        <Tooltip.Content side="bottom">
                            Toggle right sidebar
                        </Tooltip.Content>
                    </Tooltip>
                </div>

                {!isMac && <WindowControls />}
            </div>
        </header>
    );
}
