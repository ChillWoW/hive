import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { ArrowClockwiseIcon, ArrowCircleUpIcon } from "@phosphor-icons/react";
import type { UpdateChannel } from "@/proto";
import { isTauri } from "@/lib/platform";
import { agoLabel, useMinuteClock } from "@/lib/time";
import { Button, SegmentedControl } from "@/ui";
import { checkNow, install, isInstalling, useUpdaterStore } from "@/updater";
import { SettingRow, SettingsSection, SwitchRow } from "../SettingsSection";
import { useSetting } from "../store";

/** About's first section: the version, update status and update settings. */
export function UpdatesSection() {
    const autoCheck = useSetting("updates", "autoCheck");
    const channel = useSetting("updates", "channel");
    const prerelease = channel.value === "prerelease";

    return (
        <SettingsSection title="Hive">
            <StatusRow />
            <SwitchRow
                label="Check automatically"
                description="Checks every few hours. Nothing installs until you click Update"
                keywords="update auto check automatic background release new version"
                setting={autoCheck}
                aria-label="Check for updates automatically"
            />
            <SettingRow
                label="Channel"
                description={
                    prerelease
                        ? "Pre-releases come first and may be unstable"
                        : "Stable releases only"
                }
                keywords="update channel prerelease pre-release beta stable early insider"
                setting={channel}
                controlClassName="w-auto"
                control={
                    <SegmentedControl
                        size="sm"
                        value={channel.value}
                        onValueChange={(value) => channel.set(value as UpdateChannel)}
                        aria-label="Update channel"
                    >
                        <SegmentedControl.Item value="stable">Stable</SegmentedControl.Item>
                        <SegmentedControl.Item value="prerelease">Pre-release</SegmentedControl.Item>
                    </SegmentedControl>
                }
            />
        </SettingsSection>
    );
}

/** What the last check found, with Check now (and Update when one is out). */
function StatusRow() {
    const { state, checking, checkedAt, error } = useUpdaterStore();
    const now = useMinuteClock();
    const [version, setVersion] = useState<string | null>(null);

    useEffect(() => {
        if (isTauri) getVersion().then(setVersion, () => {});
    }, []);

    const current = version ? `Hive ${version}` : "Hive";
    const working = isInstalling(state);
    const description = checking
        ? "Checking…"
        : error
          ? <span className="text-danger">Couldn't check: {error}</span>
          : state.phase === "failed"
            ? <span className="text-danger">Update failed: {state.error}</span>
            : state.phase !== "none"
            ? `Hive ${state.update.version} is available`
            : checkedAt
              ? `${current} is up to date · checked ${agoLabel(checkedAt, now)}`
              : `${current} · not checked yet`;

    return (
        <SettingRow
            label="Version"
            description={description}
            keywords="about version release build update check now install latest"
            controlClassName="w-auto gap-1.5"
            control={
                <>
                    {state.phase !== "none" && (
                        <Button
                            size="sm"
                            variant="primary"
                            loading={working}
                            leftIcon={<ArrowCircleUpIcon className="size-3.5" weight="fill" />}
                            onClick={() => void install()}
                        >
                            Update
                        </Button>
                    )}
                    <Button
                        size="sm"
                        variant="default"
                        loading={checking}
                        disabled={working}
                        leftIcon={<ArrowClockwiseIcon className="size-3.5" />}
                        onClick={() => void checkNow()}
                    >
                        Check now
                    </Button>
                </>
            }
        />
    );
}
