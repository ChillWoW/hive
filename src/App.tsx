import { SettingsModal, useSettingsRuntime } from "@/features/settings";
import { useFontRuntime } from "@/features/fonts/useFontRuntime";
import { useThemeRuntime } from "@/features/theme/useThemeRuntime";
import { useUpdaterRuntime } from "@/features/updater";
import { useKeybindingsRuntime } from "@/keybindings";
import { Sidebar, TopBar } from "@/layout";

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
            <main className="min-w-0 flex-1 pt-9" />
            <SettingsModal />
        </div>
    );
}
