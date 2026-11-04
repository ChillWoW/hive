import { SIDEBAR_WIDTH, useLayoutStore, usePanelLayout } from "@/stores/useLayoutStore";
import { BarButton } from "./BarButton";
import { ChatDetailsButton } from "./ChatDetails";
import { useWindowState } from "./useWindowState";
import { WindowControls } from "./WindowControls";
import { chats, useChatsStore } from "@/chats";
import { composer } from "@/composer";
import { useEffect, useRef, useState } from "react";
import { openFileSearch, openTextSearch } from "@/files";
import {
    closeShownTab,
    openDiffTab,
    openHistoryTab,
    openTerminalTab,
    TabStrip
} from "@/rightbar";
import { HarnessIcon } from "@/harnesses";
import { useShortcut } from "@/keybindings";
import { cn } from "@/lib/cn";
import { isMac } from "@/lib/platform";
import { useResizeObserver } from "@/lib/useResizeObserver";
import type { HarnessId } from "@/proto";
import { FolderTreeIcon } from "@/ui";
import {
    ArrowLeftIcon,
    ArrowRightIcon,
    PlusIcon,
    SidebarSimpleIcon
} from "@phosphor-icons/react";

type TopBarProps = {
    title?: string;
    /** The subagent threads open in the chat, outermost first: `title / a / b`. */
    subagents?: string[];
    /** The open chat's harness, marked before the title. */
    harness?: HarnessId;
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

export function TopBar({ title, subagents = [], harness }: TopBarProps) {
    const { fullscreen } = useWindowState();
    const insetForTrafficLights = isMac && !fullscreen;

    // What's shown, not what's open: a panel hidden for room reads as closed.
    const layout = usePanelLayout();
    const { sidebar: open, files: filePanelOpen, right: rightOpen } = layout.visible;
    const resizing = useLayoutStore((state) => state.resizing);
    const toggle = useLayoutStore((state) => state.toggle);

    // The right sidebar's tabs sit in this bar above it. The panel toggles and
    // window controls keep the corner: over the file panel while it's wide
    // enough, else they take the end of the tabs' room.
    const trailing = useRef<HTMLDivElement>(null);
    const [trailingWidth, setTrailingWidth] = useState(0);
    useResizeObserver(trailing, (el) => setTrailingWidth(el.offsetWidth));
    const tabsWidth = Math.max(0, layout.right - Math.max(0, trailingWidth - layout.files));
    const tabsGap = Math.max(0, layout.files - trailingWidth);

    const toggleSidebar = () => toggle("sidebar");
    const toggleFilePanel = () => toggle("files");
    const toggleRightSidebar = () => toggle("right");
    const newChat = () => {
        composer.startNewChat();
        chats.select(null);
        composer.focus();
    };
    useShortcut("toggleSidebar", toggleSidebar);
    useShortcut("newChat", newChat);
    useShortcut("newTerminal", () => openTerminalTab());
    useShortcut("openDiff", () => openDiffTab());
    useShortcut("openHistory", () => openHistoryTab());
    useShortcut("toggleFilePanel", toggleFilePanel);
    useShortcut("toggleRightSidebar", toggleRightSidebar);
    useShortcut("searchFiles", () => openFileSearch());
    useShortcut("searchInFiles", openTextSearch);
    useShortcut("closeTab", closeShownTab);

    const canGoBack = useChatsStore((s) => s.back.length > 0);
    const canGoForward = useChatsStore((s) => s.forward.length > 0);
    useShortcut("goBack", chats.goBack);
    useShortcut("goForward", chats.goForward);
    useMouseNavigation();

    return (
        <header
            data-tauri-drag-region
            className="absolute inset-x-0 top-0 z-10 flex h-9 select-none items-center bg-transparent"
        >
            <div
                data-tauri-drag-region
                style={{ width: open ? SIDEBAR_WIDTH : 0 }}
                className="relative flex h-full min-w-fit shrink-0 items-center transition-[width]"
            >
                {insetForTrafficLights && (
                    <div data-tauri-drag-region className={MAC_TRAFFIC_LIGHTS} />
                )}

                <div data-tauri-drag-region className="flex h-full items-center gap-0.5 px-2">
                    <BarButton label="Toggle sidebar" shortcut="toggleSidebar" onClick={toggleSidebar}>
                        <SidebarSimpleIcon weight={open ? "fill" : "regular"} className="size-4" />
                    </BarButton>
                    <BarButton
                        label="Back"
                        shortcut="goBack"
                        onClick={chats.goBack}
                        disabled={!canGoBack}
                    >
                        <ArrowLeftIcon className="size-4" />
                    </BarButton>
                    <BarButton
                        label="Forward"
                        shortcut="goForward"
                        onClick={chats.goForward}
                        disabled={!canGoForward}
                    >
                        <ArrowRightIcon className="size-4" />
                    </BarButton>
                    <BarButton label="New chat" shortcut="newChat" onClick={newChat}>
                        <PlusIcon className="size-4" />
                    </BarButton>
                </div>
            </div>

            <div
                data-tauri-drag-region
                className={cn(
                    "flex h-full min-w-0 flex-1 items-center gap-1",
                    // No room for the title while the right sidebar is maximized.
                    layout.maximized ? "overflow-hidden" : "px-3"
                )}
            >
                {harness && <HarnessIcon harness={harness} className="size-3.5 shrink-0" />}
                {title && (
                    <span
                        className={cn(
                            "truncate text-[13px]",
                            subagents.length > 0 ? "max-w-[40%] shrink text-dark-200" : "text-dark-50"
                        )}
                    >
                        {title}
                    </span>
                )}
                {title &&
                    subagents.map((name, i) => (
                        <span key={i} className="flex min-w-0 items-center gap-1 text-[13px]">
                            <span className="shrink-0 text-dark-300">/</span>
                            <span
                                className={cn(
                                    "truncate",
                                    i === subagents.length - 1 ? "text-dark-50" : "text-dark-200"
                                )}
                            >
                                {name}
                            </span>
                        </span>
                    ))}
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
                    <ChatDetailsButton />
                    <BarButton
                        label="Toggle file panel"
                        shortcut="toggleFilePanel"
                        onClick={toggleFilePanel}
                        pressed={filePanelOpen}
                    >
                        <FolderTreeIcon weight={filePanelOpen ? "fill" : "regular"} className="size-4" />
                    </BarButton>
                    <BarButton
                        label="Toggle right sidebar"
                        shortcut="toggleRightSidebar"
                        onClick={toggleRightSidebar}
                        pressed={rightOpen}
                    >
                        <SidebarSimpleIcon
                            weight={rightOpen ? "fill" : "regular"}
                            className="size-4 -scale-x-100"
                        />
                    </BarButton>
                </div>

                {!isMac && <WindowControls />}
            </div>
        </header>
    );
}
