import { isMac } from "@/lib/platform";
import { Switch } from "@/ui";
import { SettingRow, SettingsSection } from "../SettingsSection";
import { useSetting } from "../store";

export function NotificationsPage() {
    const turnFinished = useSetting("notifications", "turnFinished");
    const needsInput = useSetting("notifications", "needsInput");
    const inputSound = useSetting("notifications", "inputSound");
    const finishedSound = useSetting("notifications", "finishedSound");
    const badge = useSetting("notifications", "badge");

    return (
        <>
            <SettingsSection title="While Hive is in the background">
                <SettingRow
                    label="Turn finished"
                    description="Notify when an agent finishes a turn or stops with an error"
                    keywords="notification notify alert done finished complete error toast"
                    setting={turnFinished}
                    control={
                        <Switch
                            checked={turnFinished.value}
                            onCheckedChange={turnFinished.set}
                            aria-label="Notify when a turn finishes"
                        />
                    }
                />
                <SettingRow
                    label="Needs input"
                    description="Notify when an agent asks a question or for approval"
                    keywords="notification notify alert question approval permission input toast"
                    setting={needsInput}
                    control={
                        <Switch
                            checked={needsInput.value}
                            onCheckedChange={needsInput.set}
                            aria-label="Notify when an agent needs input"
                        />
                    }
                />
            </SettingsSection>

            <SettingsSection title="Alerts">
                <SettingRow
                    label="Sound on questions"
                    description="Play a chime when an agent asks a question or for approval"
                    keywords="sound chime audio beep question approval permission"
                    setting={inputSound}
                    control={
                        <Switch
                            checked={inputSound.value}
                            onCheckedChange={inputSound.set}
                            aria-label="Sound on questions"
                        />
                    }
                />
                <SettingRow
                    label="Sound when a turn finishes"
                    description="Play a chime when an agent finishes a turn or stops with an error"
                    keywords="sound chime audio beep done finished complete error"
                    setting={finishedSound}
                    control={
                        <Switch
                            checked={finishedSound.value}
                            onCheckedChange={finishedSound.set}
                            aria-label="Sound when a turn finishes"
                        />
                    }
                />
                <SettingRow
                    label={isMac ? "Dock badge" : "Taskbar badge"}
                    description={`Show the number of unseen chats on Hive's ${isMac ? "Dock" : "taskbar"} icon`}
                    keywords="badge taskbar dock icon unread unseen count"
                    setting={badge}
                    control={
                        <Switch
                            checked={badge.value}
                            onCheckedChange={badge.set}
                            aria-label="Unseen chats badge"
                        />
                    }
                />
            </SettingsSection>
        </>
    );
}
