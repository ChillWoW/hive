import { PlayIcon } from "@phosphor-icons/react";
import { notify, playSound, SOUNDS } from "@/features/notifications";
import { isMac } from "@/lib/platform";
import { Button, IconButton, Select, Slider } from "@/ui";
import { SettingRow, SettingsSection, SwitchRow } from "../SettingsSection";
import { useSetting } from "../store";
import type { NotificationSound } from "../types";

export function NotificationsPage() {
    return (
        <>
            <AlertsSection />
            <SoundsSection />
        </>
    );
}

function AlertsSection() {
    const desktop = useSetting("notifications", "desktop");
    const badge = useSetting("notifications", "badge");
    const onlyInBackground = useSetting("notifications", "onlyInBackground");

    return (
        <SettingsSection title="Alerts">
            <SwitchRow
                label="System notifications"
                description="When a chat finishes, needs your input or fails"
                keywords="notification desktop os toast alert banner done finished input approval question error"
                setting={desktop}
            />
            <SwitchRow
                label={isMac ? "Dock badge" : "Taskbar badge"}
                description="Counts the chats waiting for you, until you're back"
                keywords="badge taskbar dock icon count unread overlay"
                setting={badge}
            />
            <SwitchRow
                label="Only in the background"
                description="Stay quiet while Outcode's window is focused"
                keywords="background focus focused window quiet mute foreground"
                setting={onlyInBackground}
            />
            <SettingRow
                label="Test"
                description="Sends the finished alert now, as set up here"
                keywords="test try preview notification sound"
                control={
                    <Button size="sm" variant="ghost" onClick={() => notify("done", null, true)}>
                        Send test
                    </Button>
                }
            />
        </SettingsSection>
    );
}

function SoundsSection() {
    const volume = useSetting("notifications", "volume");

    return (
        <SettingsSection title="Sounds">
            <SoundRow
                setting="doneSound"
                label="Finished"
                description="A chat's turn completed"
                keywords="sound done finished complete turn audio"
            />
            <SoundRow
                setting="inputSound"
                label="Needs input"
                description="An approval, a question, a plan or a secret"
                keywords="sound input approval question plan secret waiting asking audio"
            />
            <SoundRow
                setting="errorSound"
                label="Failed"
                description="A chat's turn stopped on an error"
                keywords="sound error failed failure crash audio"
            />
            <SettingRow
                label="Volume"
                keywords="sound volume loud quiet level audio"
                setting={volume}
                control={
                    <Slider
                        size="sm"
                        aria-label="Volume"
                        min={0}
                        max={100}
                        step={5}
                        value={volume.value}
                        onValueChange={(next: number) => volume.set(next)}
                        onValueCommitted={(next: number) => playSound("ping", next)}
                    />
                }
            />
        </SettingsSection>
    );
}

function SoundRow({
    setting,
    ...row
}: {
    setting: "doneSound" | "inputSound" | "errorSound";
    label: string;
    description: string;
    keywords: string;
}) {
    const sound = useSetting("notifications", setting);
    const volume = useSetting("notifications", "volume").value;

    return (
        <SettingRow
            {...row}
            setting={sound}
            control={
                <div className="flex w-full items-center gap-1.5">
                    <IconButton
                        label="Play"
                        disabled={sound.value === "none"}
                        onClick={() => playSound(sound.value, volume)}
                    >
                        <PlayIcon weight="fill" className="size-3.5" />
                    </IconButton>
                    <Select
                        items={SOUNDS}
                        value={sound.value}
                        onValueChange={(next: NotificationSound | null) => {
                            if (!next) return;
                            sound.set(next);
                            playSound(next, volume);
                        }}
                    >
                        <Select.Trigger aria-label={`${row.label} sound`}>
                            <Select.Value />
                        </Select.Trigger>
                        <Select.Content>
                            {SOUNDS.map((option) => (
                                <Select.Item key={option.value} value={option.value}>
                                    {option.label}
                                </Select.Item>
                            ))}
                        </Select.Content>
                    </Select>
                </div>
            }
        />
    );
}
