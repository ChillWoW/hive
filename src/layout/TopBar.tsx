import { SIDEBAR_WIDTH, useLayoutStore } from "@/stores/useLayoutStore";
import { useWindowState } from "./useWindowState";
import { WindowControls } from "./WindowControls";
import { chats } from "@/chats";
import { composer } from "@/composer";
import { useShortcut, useShortcutTitle } from "@/keybindings";
import { cn } from "@/lib/cn";
import { isMac } from "@/lib/platform";
import { Button } from "@/ui";
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
    const sidebarTitle = useShortcutTitle("toggleSidebar", "Toggle sidebar");
    const newChatTitle = useShortcutTitle("newChat", "New chat");

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
                    <Button
                        variant="ghost"
                        onClick={toggleSidebar}
                        aria-label="Toggle sidebar"
                        title={sidebarTitle}
                        className="p-0 size-6"
                    >
                        <SidebarSimpleIcon className="size-4" />
                    </Button>

                    <Button variant="ghost" className="p-0 size-6">
                        <ArrowLeftIcon className="size-4" />
                    </Button>

                    <Button variant="ghost" className="p-0 size-6">
                        <ArrowRightIcon className="size-4" />
                    </Button>

                    <Button
                        variant="ghost"
                        aria-label="New chat"
                        title={newChatTitle}
                        onClick={newChat}
                        className="p-0 size-6"
                    >
                        <PlusIcon className="size-4" />
                    </Button>
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
