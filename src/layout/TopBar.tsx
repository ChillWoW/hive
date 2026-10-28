import { SIDEBAR_WIDTH, useLayoutStore } from "@/stores/useLayoutStore";
import { useWindowState } from "./useWindowState";
import { WindowControls } from "./WindowControls";
import { chats, useChatsStore } from "@/chats";
import { composer } from "@/composer";
import { useEffect } from "react";
import { useShortcut } from "@/keybindings";
import { cn } from "@/lib/cn";
import { isMac } from "@/lib/platform";
import { Button, Tooltip } from "@/ui";
import {
    ArrowLeftIcon,
    ArrowRightIcon,
    PlusIcon,
    SidebarSimpleIcon
} from "@phosphor-icons/react";

type TopBarProps = {
    title?: string;
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

export function TopBar({ title, className }: TopBarProps) {
    const { fullscreen } = useWindowState();
    const insetForTrafficLights = isMac && !fullscreen;

    const open = useLayoutStore((state) => state.sidebarOpen);
    const toggleSidebar = useLayoutStore((state) => state.toggleSidebar);
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
                                    <SidebarSimpleIcon className="size-4" />
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
                {title && (
                    <span className="truncate text-[13px] text-dark-50">
                        {title}
                    </span>
                )}
                {/* Spacer: an empty strip you can grab to drag the window. */}
                <div data-tauri-drag-region className="h-full flex-1" />
                {/* right-side actions go here */}
            </div>

            {!isMac && <WindowControls />}
        </header>
    );
}
