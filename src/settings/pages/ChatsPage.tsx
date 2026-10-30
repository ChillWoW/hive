import { Switch } from "@/ui";
import { SettingRow, SettingsSection } from "../SettingsSection";
import { useSetting } from "../store";
import { TextGenerationRow } from "./TextGenerationRow";

export function ChatsPage() {
    const resume = useSetting("chats", "resumeInterrupted");
    const autoTitle = useSetting("chats", "autoTitle");

    return (
        <>
            <SettingsSection title="New chats">
                <SettingRow
                    label="Auto-title chats"
                    description="A quick model run names each new chat. Off, its first words do"
                    keywords="title name rename auto generate summary tokens"
                    setting={autoTitle}
                    control={
                        <Switch
                            checked={autoTitle.value}
                            onCheckedChange={autoTitle.set}
                            aria-label="Auto-title chats"
                        />
                    }
                />
            </SettingsSection>

            <SettingsSection title="Text generation">
                <TextGenerationRow />
            </SettingsSection>

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
        </>
    );
}
