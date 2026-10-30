import { NumberInput, Switch } from "@/ui";
import { SettingRow, SettingsSection } from "../SettingsSection";
import { useSetting } from "../store";
import { TextGenerationRow } from "./TextGenerationRow";

export function ChatsPage() {
    const resume = useSetting("chats", "resumeInterrupted");
    const autoTitle = useSetting("chats", "autoTitle");
    const autoArchive = useSetting("chats", "autoArchive");
    const archiveDays = useSetting("chats", "autoArchiveDays");

    return (
        <>
            <SettingsSection title="New chats">
                <SettingRow
                    label="Auto-title chats"
                    description="A model run names new chats. Off, their first words do"
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

            <SettingsSection title="Archiving">
                <SettingRow
                    label="Auto-archive chats"
                    description="Idle chats move to Archived. Pinned and running ones stay"
                    keywords="archive auto old inactive idle cleanup sidebar"
                    setting={autoArchive}
                    control={
                        <Switch
                            checked={autoArchive.value}
                            onCheckedChange={autoArchive.set}
                            aria-label="Auto-archive chats"
                        />
                    }
                />
                {autoArchive.value && (
                    <SettingRow
                        label="Archive after"
                        description="Days without activity. A new message brings a chat back"
                        keywords="archive days time age old inactive idle"
                        setting={archiveDays}
                        control={
                            <NumberInput
                                size="sm"
                                align="right"
                                decimalPlaces={0}
                                min={1}
                                max={365}
                                value={archiveDays.value}
                                onValueChange={(days) => {
                                    if (days !== null && days >= 1) archiveDays.set(days);
                                }}
                                suffix="days"
                                aria-label="Days before archiving"
                            />
                        }
                    />
                )}
            </SettingsSection>

            <SettingsSection title="Sessions">
                <SettingRow
                    label="Resume interrupted turns"
                    description="Continue cut-short turns on next launch. Uses tokens"
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

            <SettingsSection title="Text generation">
                <TextGenerationRow />
            </SettingsSection>
        </>
    );
}
