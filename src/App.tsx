import { ChatView } from "@/features/chat";
import { SettingsModal, useSettingsRuntime } from "@/features/settings";
import { useFontRuntime } from "@/features/fonts/useFontRuntime";
import { useThemeRuntime } from "@/features/theme/useThemeRuntime";
import { useUpdaterRuntime } from "@/features/updater";
import { useKeybindingsRuntime } from "@/keybindings";
import { FilePanel, RightSidebar, Sidebar, TopBar } from "@/layout";
import { Toaster } from "@/ui";

export function App() {
    useSettingsRuntime();
    useThemeRuntime();
    useFontRuntime();
    useKeybindingsRuntime();
    useUpdaterRuntime();

    return (
        <div className="relative flex h-screen bg-bg text-text">
            <TopBar />
            <Sidebar />
            <main className="flex min-w-0 flex-1 flex-col overflow-hidden pt-9">
                <ChatView />
            </main>
            <RightSidebar />
            <FilePanel />
            <SettingsModal />
            <Toaster />
        </div>
    );
}
