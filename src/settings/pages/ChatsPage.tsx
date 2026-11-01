import { NumberInput } from "@/ui";
import { SettingRow, SettingsSection, SwitchRow } from "../SettingsSection";
import { useSetting } from "../store";
import { TextGenerationRow } from "./TextGenerationRow";

export function ChatsPage() {
    const resume = useSetting("chats", "resumeInterrupted");
    const autoTitle = useSetting("chats", "autoTitle");
    const autoArchive = useSetting("chats", "autoArchive");
    const archiveDays = useSetting("chats", "autoArchiveDays");
    const showActivity = useSetting("chats", "showActivity");

    return (
        <>
            <SettingsSection title="New chats">
                <SwitchRow
                    label="Auto-title chats"
                    description="A model run names new chats. Off, their first words do"
                    keywords="title name rename auto generate summary tokens"
                    setting={autoTitle}
                />
            </SettingsSection>

            <SettingsSection title="Sidebar">
                <SwitchRow
                    label="Show agent activity"
                    description="A line under a working chat's title saying what its agent is doing"
                    keywords="sidebar activity status working tool line agent doing progress"
                    setting={showActivity}
                />
            </SettingsSection>

            <SettingsSection title="Archiving">
                <SwitchRow
                    label="Auto-archive chats"
                    description="Idle chats move to Archived. Pinned and running ones stay"
                    keywords="archive auto old inactive idle cleanup sidebar"
                    setting={autoArchive}
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
                <SwitchRow
                    label="Resume interrupted turns"
                    description="Continue cut-short turns on next launch. Uses tokens"
                    keywords="resume restart continue crash interrupted relaunch startup"
                    setting={resume}
                />
            </SettingsSection>

            <SettingsSection title="Text generation">
                <TextGenerationRow />
            </SettingsSection>
        </>
    );
}
