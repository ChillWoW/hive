import { SettingsPage } from "@/features/settings/SettingsPage";
import { useSettingsRuntime } from "@/features/settings/useSettingsRuntime";

export function App() {
    useSettingsRuntime();

    return (
        <div className="h-screen bg-neutral-900 text-neutral-50">
            <SettingsPage />
        </div>
    );
}
