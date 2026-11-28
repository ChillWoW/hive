import { FolderOpenIcon } from "@phosphor-icons/react";
import { FontPicker } from "@/features/fonts/FontPicker";
import { LayoutSection } from "./LayoutSection";
import { ThemePicker } from "@/features/theme/ThemePicker";
import { themesApi } from "@/features/theme/store";
import { isTauri } from "@/lib/platform";
import { Button } from "@/ui";
import { SettingRow, SettingsSection } from "../SettingsSection";
import { useSetting } from "../store";

export function AppearancePage() {
    return (
        <>
            <ThemeSection />
            <FontSection />
            <LayoutSection />
        </>
    );
}

function ThemeSection() {
    const theme = useSetting("appearance", "theme");

    return (
        <SettingsSection title="Theme">
            <SettingRow
                label="Theme"
                description="Colours for the whole app"
                keywords="theme colors colours dark light palette appearance"
                setting={theme}
                controlClassName="w-56"
                control={<ThemePicker value={theme.value} onChange={theme.set} />}
            />
            <SettingRow
                label="Custom themes"
                description="Drop a theme's .json file in the themes folder"
                keywords="theme custom user folder directory json colors colours import"
                controlClassName="w-auto"
                control={
                    isTauri && (
                        <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => void themesApi.openDir()}
                        >
                            <FolderOpenIcon />
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
    const codeFont = useSetting("appearance", "codeFontFamily");

    return (
        <SettingsSection title="Font">
            <SettingRow
                label="Interface font"
                description="The typeface for the app's text"
                keywords="font family typeface typography text ui geist system sf pro"
                setting={fontFamily}
                controlClassName="w-56"
                control={<FontPicker value={fontFamily.value} onChange={fontFamily.set} />}
            />
            <SettingRow
                label="Code font"
                description="The typeface for code blocks and diffs"
                keywords="font family typeface monospace mono code diff editor"
                setting={codeFont}
                controlClassName="w-56"
                control={
                    <FontPicker
                        value={codeFont.value}
                        onChange={codeFont.set}
                        label="Code font"
                        fallback="ui-monospace, monospace"
                        empty="System monospace"
                    />
                }
            />
        </SettingsSection>
    );
}
