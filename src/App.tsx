import { useState, type CSSProperties } from "react";
import { ChatView } from "@/chat/ChatView";
import { useChat, useChatsRuntime, useChatsStore } from "@/chats";
import { folderName } from "@/composer";
import { useHtmlCheckRuntime } from "@/htmlpage";
import { useKeybindingsRuntime } from "@/keybindings";
import { RightPanels, Sidebar, TopBar, WINDOW_CONTROLS_WIDTH } from "@/layout";
import { isMac } from "@/lib/platform";
import { useNotificationsRuntime } from "@/notifications";
import { CommandPalette, usePaletteRuntime } from "@/palette";
import { SettingsModal, useSettingsRuntime } from "@/settings";
import { PortalContainerProvider } from "@/ui";
import { useUpdaterRuntime } from "@/updater";
import { UsageModal, useUsageRuntime } from "@/usage";

export function App() {
    useKeybindingsRuntime();
    useSettingsRuntime();
    useChatsRuntime();
    useNotificationsRuntime();
    useUpdaterRuntime();
    useUsageRuntime();
    usePaletteRuntime();
    useHtmlCheckRuntime();
    const chat = useChat(useChatsStore((s) => s.activeChatId));
    const title = chat ? (chat.title ?? folderName(chat.cwd)) : undefined;
    // Overlays mount here, below the top bar, so an open modal never takes
    // the window's drag region or its controls.
    const [overlayLayer, setOverlayLayer] = useState<HTMLDivElement | null>(
        null
    );
    // Over the top bar: a modal's dim there keeps a drag region under it and
    // leaves the window controls clickable.
    const [chromeLayer, setChromeLayer] = useState<HTMLDivElement | null>(
        null
    );

    return (
        <PortalContainerProvider container={overlayLayer} chrome={chromeLayer}>
            <div className="relative flex h-full w-full overflow-hidden bg-dark-900 text-dark-50">
                <Sidebar />
                <main className="flex min-w-0 flex-1 flex-col overflow-hidden pt-9">
                    <ChatView />
                </main>
                <RightPanels />
                <TopBar title={title} harness={chat?.config.harness} />
                <div
                    ref={setOverlayLayer}
                    className="pointer-events-none absolute inset-x-0 top-9 bottom-0 z-40"
                />
                <div
                    ref={setChromeLayer}
                    style={
                        {
                            "--chrome-controls": `${isMac ? 0 : WINDOW_CONTROLS_WIDTH}px`
                        } as CSSProperties
                    }
                    className="pointer-events-none absolute inset-x-0 top-0 z-40 h-9"
                />
            </div>
            <SettingsModal />
            <UsageModal />
            <CommandPalette />
        </PortalContainerProvider>
    );
}
