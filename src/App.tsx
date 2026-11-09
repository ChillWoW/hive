import { SettingsModal, useSettingsRuntime } from "@/features/settings";
import { useThemeRuntime } from "@/features/theme/useThemeRuntime";
import { useUpdaterRuntime } from "@/features/updater";
import { useKeybindingsRuntime } from "@/keybindings";

export function App() {
    useSettingsRuntime();
    useThemeRuntime();
    useKeybindingsRuntime();
    useUpdaterRuntime();

    return (
        <div className="h-screen bg-bg text-text">
            <SettingsModal />
        </div>
    );
}
