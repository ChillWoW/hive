import { useEffect, useState } from "react";
import { themesApi } from "@/features/theme/store";
import { ThemePicker } from "@/features/theme/ThemePicker";
import { isTauri, REVEAL_LABEL } from "@/lib/platform";
import { SegmentedControl } from "@/ui/SegmentedControl";
import { settingsApi } from "./api";
import { SettingRow, SettingsSection, SwitchRow } from "./SettingsSection";
import { useSetting, useSettingsStore } from "./store";
import type { UpdateChannel } from "./types";

/** Every setting on one page, for now. */
export function SettingsPage() {
    return (
        <div className="h-full overflow-y-auto">
            <div className="mx-auto flex max-w-2xl flex-col gap-8 px-6 py-10">
                <h1 className="px-1 text-lg font-semibold text-text">Settings</h1>
                <AppearanceSection />
                <UpdatesSection />
                <FileSection />
            </div>
        </div>
    );
}

function AppearanceSection() {
    const theme = useSetting("appearance", "theme");

    return (
        <SettingsSection title="Appearance">
            <SettingRow
                label="Theme"
                description="Add your own as JSON files in the themes folder"
                setting={theme}
                control={
                    <button
                        type="button"
                        disabled={!isTauri}
                        onClick={() => void themesApi.openDir()}
                        className="rounded-md bg-raised px-2.5 py-1 text-xs font-medium text-text hover:bg-hover disabled:opacity-50"
                    >
                        Open themes folder
                    </button>
                }
            />
            <ThemePicker value={theme.value} onChange={theme.set} />
        </SettingsSection>
    );
}

const CHANNELS: { value: UpdateChannel; label: string }[] = [
    { value: "stable", label: "Stable" },
    { value: "prerelease", label: "Pre-release" }
];

function UpdatesSection() {
    const autoCheck = useSetting("updates", "autoCheck");
    const channel = useSetting("updates", "channel");

    return (
        <SettingsSection title="Updates">
            <SwitchRow
                label="Check automatically"
                description="Look for a new release at launch and every few hours"
                setting={autoCheck}
            />
            <SettingRow
                label="Channel"
                description="Pre-release includes builds not marked as latest"
                setting={channel}
                control={
                    <SegmentedControl
                        aria-label="Update channel"
                        value={channel.value}
                        options={CHANNELS}
                        onChange={channel.set}
                    />
                }
            />
        </SettingsSection>
    );
}

function FileSection() {
    const resetAll = useSettingsStore((s) => s.resetAll);
    const [path, setPath] = useState<string | null>(null);

    useEffect(() => {
        settingsApi.path().then(setPath, () => {});
    }, []);

    return (
        <SettingsSection title="Settings file">
            <SettingRow
                label="settings.json"
                description={path ?? "Stored in the browser under bun run dev"}
                control={
                    <button
                        type="button"
                        disabled={!path}
                        onClick={() => void settingsApi.reveal()}
                        className="rounded-md bg-hover px-2.5 py-1 text-xs font-medium text-text hover:bg-border disabled:opacity-50"
                    >
                        {REVEAL_LABEL}
                    </button>
                }
            />
            <SettingRow
                label="Reset all settings"
                description="Put every setting back to its default"
                control={
                    <button
                        type="button"
                        onClick={() => void resetAll()}
                        className="rounded-md bg-hover px-2.5 py-1 text-xs font-medium text-danger hover:bg-border"
                    >
                        Reset
                    </button>
                }
            />
        </SettingsSection>
    );
}
