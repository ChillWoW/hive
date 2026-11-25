import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import {
    ArrowCircleUpIcon,
    ArrowClockwiseIcon,
    ArrowCounterClockwiseIcon,
    FolderOpenIcon
} from "@phosphor-icons/react";
import { checkNow, isInstalling, UpdateDialog, useUpdaterStore } from "@/features/updater";
import { tildify, useHomeDir } from "@/lib/home";
import { isTauri } from "@/lib/platform";
import { agoLabel, useMinuteClock } from "@/lib/time";
import { Button, SegmentedControl } from "@/ui";
import { settingsApi } from "../api";
import { CopyButton } from "../CopyButton";
import { useConfirmPress } from "../hooks";
import { SettingRow, SettingsSection, SwitchRow } from "../SettingsSection";
import { useSetting, useSettingsStore } from "../store";
import type { UpdateChannel } from "../types";

export function AboutPage() {
    return (
        <>
            <UpdatesSection />
            <SettingsFileSection />
        </>
    );
}

/** The version and update settings. */
function UpdatesSection() {
    const autoCheck = useSetting("updates", "autoCheck");
    const channel = useSetting("updates", "channel");
    const prerelease = channel.value === "prerelease";

    return (
        <SettingsSection title="Outcode">
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
    const [confirming, setConfirming] = useState(false);

    useEffect(() => {
        if (isTauri) getVersion().then(setVersion, () => {});
    }, []);

    const current = version ? `Outcode ${version}` : "Outcode";
    const working = isInstalling(state);
    const description = checking ? (
        "Checking…"
    ) : error ? (
        <span className="text-danger">Couldn't check: {error}</span>
    ) : state.phase === "failed" ? (
        <span className="text-danger">Update failed: {state.error}</span>
    ) : state.phase === "downloading" ? (
        `Downloading Outcode ${state.update.version}…${
            state.progress === undefined ? "" : ` ${Math.round(state.progress * 100)}%`
        }`
    ) : state.phase === "installing" ? (
        "Restarting…"
    ) : state.phase === "available" ? (
        `Outcode ${state.update.version} is available`
    ) : checkedAt ? (
        `${current} is up to date · checked ${agoLabel(checkedAt, now)}`
    ) : (
        `${current} · not checked yet`
    );

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
                            variant="default"
                            loading={working}
                            onClick={() => setConfirming(true)}
                        >
                            {!working && <ArrowCircleUpIcon weight="fill" />}
                            Update
                        </Button>
                    )}
                    <Button
                        size="sm"
                        variant="secondary"
                        loading={checking}
                        disabled={working}
                        onClick={() => void checkNow()}
                    >
                        {!checking && <ArrowClockwiseIcon />}
                        Check now
                    </Button>
                    <UpdateDialog open={confirming} onClose={() => setConfirming(false)} />
                </>
            }
        />
    );
}

function SettingsFileSection() {
    const [path, setPath] = useState<string | null>(null);
    const home = useHomeDir();

    useEffect(() => {
        settingsApi.path().then(setPath, () => {});
    }, []);

    return (
        <SettingsSection title="Settings file">
            <SettingRow
                label="Location"
                description={
                    path ? (
                        <span className="font-mono text-[11px] break-all text-muted">
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
                                variant="secondary"
                                onClick={() => void settingsApi.reveal()}
                            >
                                <FolderOpenIcon />
                                Reveal
                            </Button>
                        </>
                    )
                }
            />
            <ResetRow />
        </SettingsSection>
    );
}

/** Two-step, so a stray click can't wipe every setting. */
function ResetRow() {
    const resetAll = useSettingsStore((s) => s.resetAll);
    const { armed, onClick, onBlur } = useConfirmPress(() => void resetAll());

    return (
        <SettingRow
            label="Reset all settings"
            description="Every setting goes back to its default"
            keywords="reset restore defaults clear factory"
            controlClassName="w-auto"
            control={
                <Button
                    size="sm"
                    variant="destructive-outline"
                    onClick={onClick}
                    onBlur={onBlur}
                >
                    <ArrowCounterClockwiseIcon />
                    {armed ? "Click to confirm" : "Reset"}
                </Button>
            }
        />
    );
}
