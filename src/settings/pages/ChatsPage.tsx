import { Switch } from "@/ui";
import { SettingRow, SettingsSection } from "../SettingsSection";
import { useSetting } from "../store";

export function ChatsPage() {
    const resume = useSetting("chats", "resumeInterrupted");

    return (
        <SettingsSection title="Sessions">
            <SettingRow
                label="Resume interrupted turns"
                description="When Hive closes mid-turn, the agent continues on next launch. Uses tokens"
                keywords="resume restart continue crash interrupted relaunch startup"
                setting={resume}
                control={
                    <Switch
                        checked={resume.value}
                        onCheckedChange={resume.set}
                        aria-label="Resume interrupted turns"
                    />
                }
            />
        </SettingsSection>
    );
}
