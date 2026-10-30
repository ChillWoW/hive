import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { ArrowClockwiseIcon, ArrowCircleUpIcon } from "@phosphor-icons/react";
import type { UpdateChannel } from "@/proto";
import { isTauri } from "@/lib/platform";
import { timeAgo, useMinuteClock } from "@/sidebar/time";
import { Button, SegmentedControl, Switch } from "@/ui";
import { checkNow, install, useUpdaterStore } from "@/updater";
import { SettingRow, SettingsSection } from "../SettingsSection";
import { useSetting } from "../store";

/** About's first section: the version, update status and update settings. */
export function UpdatesSection() {
    const autoCheck = useSetting("updates", "autoCheck");
    const channel = useSetting("updates", "channel");
    const prerelease = channel.value === "prerelease";

    return (
        <SettingsSection title="Hive">
            <StatusRow />
            <SettingRow
                label="Check automatically"
                description="At launch and every few hours. Nothing installs until you click Update"
                keywords="update auto check automatic background release new version"
                setting={autoCheck}
                control={
                    <Switch
                        checked={autoCheck.value}
                        onCheckedChange={autoCheck.set}
                        aria-label="Check for updates automatically"
                    />
                }
            />
            <SettingRow
                label="Channel"
                description={
                    prerelease
                        ? "Pre-releases arrive first and may be unstable. Switching back waits for a stable release past yours"
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
    const working = state.phase === "downloading" || state.phase === "installing";
    const description = checking
        ? "Checking…"
        : error
          ? <span className="text-danger">Couldn't check: {error}</span>
          : state.phase === "failed"
            ? <span className="text-danger">Update failed: {state.error}</span>
            : state.phase !== "none"
            ? `Hive ${state.update.version} is available`
            : checkedAt
              ? `${current} is up to date · checked ${ago(checkedAt, now)}`
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

function ago(at: number, now: number): string {
    const text = timeAgo(at, Math.max(now, at));
    return text === "now" ? "just now" : `${text} ago`;
}
