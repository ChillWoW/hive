import { FolderOpenIcon } from "@phosphor-icons/react";
import { FontPicker } from "@/features/fonts/FontPicker";
import { ThemePicker } from "@/features/theme/ThemePicker";
import { themesApi } from "@/features/theme/store";
import { isTauri } from "@/lib/platform";
import { Button } from "@/ui";
import { matchesQuery, useSettingsQuery } from "../search";
import { SettingRow, SettingsSection } from "../SettingsSection";
import { useSetting } from "../store";

export function AppearancePage() {
    return (
        <>
            <ThemeSection />
            <FontSection />
        </>
    );
}

function ThemeSection() {
    const theme = useSetting("appearance", "theme");
    const query = useSettingsQuery();
    const showPicker = matchesQuery(query, "Theme", "colors colours dark light palette appearance");

    return (
        <SettingsSection title="Theme">
            {showPicker && (
                <div data-setting-row>
                    <ThemePicker value={theme.value} onChange={theme.set} />
                </div>
            )}
            <SettingRow
                label="Custom themes"
                description="Drop a theme's .json file in the themes folder"
                keywords="theme custom user folder directory json colors colours import"
                controlClassName="w-auto"
                control={
                    isTauri && (
                        <Button
                            size="sm"
                            variant="default"
                            leftIcon={<FolderOpenIcon className="size-3.5" />}
                            onClick={() => void themesApi.openDir()}
                        >
                            Open folder
                        </Button>
                    )
                }
            />
        </SettingsSection>
    );
}

function FontSection() {
    const fontFamily = useSetting("appearance", "fontFamily");

    return (
        <SettingsSection title="Font">
            <SettingRow
                label="Interface font"
                description="The typeface for the app's text"
                keywords="font family typeface typography text ui geist"
                setting={fontFamily}
                controlClassName="w-56"
                control={<FontPicker value={fontFamily.value} onChange={fontFamily.set} />}
            />
        </SettingsSection>
    );
}
