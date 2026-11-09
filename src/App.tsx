import { useSettingsRuntime } from "@/features/settings/useSettingsRuntime";
import { useThemeRuntime } from "@/features/theme/useThemeRuntime";

export function App() {
    useSettingsRuntime();
    useThemeRuntime();

    return <div className="h-screen bg-bg text-text" />;
}
