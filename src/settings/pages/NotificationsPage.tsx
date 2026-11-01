import { isMac } from "@/lib/platform";
import { SettingsSection, SwitchRow } from "../SettingsSection";
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
                <SwitchRow
                    label="Turn finished"
                    description="Notify when an agent finishes a turn or stops with an error"
                    keywords="notification notify alert done finished complete error toast"
                    setting={turnFinished}
                    aria-label="Notify when a turn finishes"
                />
                <SwitchRow
                    label="Needs input"
                    description="Notify when an agent asks a question or for approval"
                    keywords="notification notify alert question approval permission input toast"
                    setting={needsInput}
                    aria-label="Notify when an agent needs input"
                />
            </SettingsSection>

            <SettingsSection title="Alerts">
                <SwitchRow
                    label="Sound on questions"
                    description="Chime when an agent asks a question or for approval"
                    keywords="sound chime audio beep question approval permission"
                    setting={inputSound}
                />
                <SwitchRow
                    label="Sound when a turn finishes"
                    description="Chime when an agent finishes a turn or stops with an error"
                    keywords="sound chime audio beep done finished complete error"
                    setting={finishedSound}
                />
                <SwitchRow
                    label={isMac ? "Dock badge" : "Taskbar badge"}
                    description={`Show the number of unseen chats on Hive's ${isMac ? "Dock" : "taskbar"} icon`}
                    keywords="badge taskbar dock icon unread unseen count"
                    setting={badge}
                    aria-label="Unseen chats badge"
                />
            </SettingsSection>
        </>
    );
}
