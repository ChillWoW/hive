import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import {
    ArrowCounterClockwiseIcon,
    FolderOpenIcon
} from "@phosphor-icons/react";
import { tildify, useHomeDir } from "@/lib/home";
import { isTauri } from "@/lib/platform";
import { Button } from "@/ui";
import { settingsApi } from "../api";
import { CopyButton } from "../CopyButton";
import { SettingRow, SettingsSection } from "../SettingsSection";
import { useSettingsStore } from "../store";

export function AboutPage() {
    const [version, setVersion] = useState<string | null>(null);
    const [path, setPath] = useState<string | null>(null);
    const home = useHomeDir();

    useEffect(() => {
        if (isTauri) getVersion().then(setVersion, () => {});
        settingsApi.path().then(setPath, () => {});
    }, []);

    return (
        <>
            <SettingsSection title="Hive">
                <SettingRow
                    label="Version"
                    keywords="about version release build"
                    description={
                        isTauri
                            ? undefined
                            : "Browser preview, no desktop shell"
                    }
                    control={
                        <span className="font-mono text-xs text-dark-100 tabular-nums">
                            {version ?? "dev"}
                        </span>
                    }
                />
            </SettingsSection>

            <SettingsSection title="Settings file">
                <SettingRow
                    label="Location"
                    description={
                        path ? (
                            <span className="font-mono text-[11px] break-all text-dark-250">
                                {tildify(path, home)}
                            </span>
                        ) : (
                            "Stored in this browser"
                        )
                    }
                    keywords="settings.json file path folder data directory reveal json edit"
                    controlClassName="w-auto gap-1.5"
                    control={
                        path && (
                            <>
                                <CopyButton text={path} />
                                <Button
                                    size="sm"
                                    variant="default"
                                    leftIcon={
                                        <FolderOpenIcon className="size-3.5" />
                                    }
                                    onClick={() => void settingsApi.reveal()}
                                >
                                    Reveal
                                </Button>
                            </>
                        )
                    }
                />
                <ResetRow />
            </SettingsSection>
        </>
    );
}

/** Two-step: the first press arms it, a second within a few seconds resets. */
function ResetRow() {
    const resetAll = useSettingsStore((s) => s.resetAll);
    const [armed, setArmed] = useState(false);

    useEffect(() => {
        if (!armed) return;
        const timer = setTimeout(() => setArmed(false), 4000);
        return () => clearTimeout(timer);
    }, [armed]);

    return (
        <SettingRow
            label="Reset all settings"
            description="Every setting goes back to its default"
            keywords="reset restore defaults clear factory"
            controlClassName="w-auto"
            control={
                <Button
                    size="sm"
                    variant="destructive"
                    leftIcon={
                        <ArrowCounterClockwiseIcon className="size-3.5" />
                    }
                    onClick={() => {
                        if (!armed) return setArmed(true);
                        setArmed(false);
                        void resetAll();
                    }}
                    onBlur={() => setArmed(false)}
                >
                    {armed ? "Click to confirm" : "Reset"}
                </Button>
            }
        />
    );
}
