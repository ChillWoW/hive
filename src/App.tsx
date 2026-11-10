import { SettingsModal, useSettingsRuntime } from "@/features/settings";
import { useFontRuntime } from "@/features/fonts/useFontRuntime";
import { useThemeRuntime } from "@/features/theme/useThemeRuntime";
import { useUpdaterRuntime } from "@/features/updater";
import { useKeybindingsRuntime } from "@/keybindings";
import { TopBar } from "@/layout";

export function App() {
    useSettingsRuntime();
    useThemeRuntime();
    useFontRuntime();
    useKeybindingsRuntime();
    useUpdaterRuntime();

    return (
        <div className="flex h-screen flex-col bg-bg text-text">
            <TopBar />
            <SettingsModal />
        </div>
    );
}
