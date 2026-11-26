import { ChatHeader, ChatView, useChatRuntime } from "@/features/chat";
import { useChatsRuntime } from "@/features/chats";
import { SettingsModal, useSettingsRuntime } from "@/features/settings";
import { useFontRuntime } from "@/features/fonts/useFontRuntime";
import { useThemeRuntime } from "@/features/theme/useThemeRuntime";
import { useUpdaterRuntime } from "@/features/updater";
import { useKeybindingsRuntime } from "@/keybindings";
import { BOX_INSET, Dock, FilePanel, RightSidebar, Sidebar, TopBar } from "@/layout";
import { Toaster } from "@/ui";

export function App() {
    useSettingsRuntime();
    useThemeRuntime();
    useFontRuntime();
    useKeybindingsRuntime();
    useUpdaterRuntime();
    useChatsRuntime();
    useChatRuntime();

    return (
        // The frame (top bar and dock, one strip around two sides) holds the
        // panels and main column in an inset box.
        <div className="flex h-screen flex-col bg-surface text-text">
            <TopBar />
            <div className="flex min-h-0 flex-1">
                <Dock />
                <div
                    style={{ marginRight: BOX_INSET, marginBottom: BOX_INSET }}
                    className="flex min-w-0 flex-1 overflow-hidden rounded-lg border border-border bg-bg"
                >
                    <Sidebar />
                    <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
                        <ChatHeader />
                        <div className="min-h-0 flex-1">
                            <ChatView />
                        </div>
                    </main>
                    <RightSidebar />
                    <FilePanel />
                </div>
            </div>
            <SettingsModal />
            <Toaster />
        </div>
    );
}
