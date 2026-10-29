import { useState } from "react";
import { ChatView } from "@/chat/ChatView";
import { useChat, useChatsRuntime, useChatsStore } from "@/chats";
import { folderName } from "@/composer";
import { useKeybindingsRuntime } from "@/keybindings";
import { RightPanels, Sidebar, TopBar } from "@/layout";
import { useNotificationsRuntime } from "@/notifications";
import { SettingsModal, useSettingsRuntime } from "@/settings";
import { PortalContainerProvider } from "@/ui";

export function App() {
    useKeybindingsRuntime();
    useSettingsRuntime();
    useChatsRuntime();
    useNotificationsRuntime();
    const chat = useChat(useChatsStore((s) => s.activeChatId));
    const title = chat ? (chat.title ?? folderName(chat.cwd)) : undefined;
    // Overlays mount here, below the top bar, so an open modal never covers
    // the window's drag region or its controls.
    const [overlayLayer, setOverlayLayer] = useState<HTMLDivElement | null>(
        null
    );

    return (
        <PortalContainerProvider container={overlayLayer}>
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
            </div>
            <SettingsModal />
        </PortalContainerProvider>
    );
}
