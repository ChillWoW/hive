import { Select, type SelectOption } from "@/ui";
import { SettingRow, SettingsSection, SwitchRow } from "../SettingsSection";
import { useSetting } from "../store";

export function ChatsPage() {
    return (
        <>
            <TitlesSection />
            <TextGenerationSection />
        </>
    );
}

/** Claude's aliases; its default as "default" (stored empty). */
const MODELS: SelectOption[] = [
    { value: "haiku", label: "Haiku" },
    { value: "sonnet", label: "Sonnet" },
    { value: "opus", label: "Opus" },
    { value: "default", label: "Claude's default" }
];

function TextGenerationSection() {
    const model = useSetting("chat", "textGenerationModel");
    const value = model.value || "default";
    // An id typed into settings.json is offered as it is.
    const options = MODELS.some((o) => o.value === value) ? MODELS : [...MODELS, { value }];

    return (
        <SettingsSection title="Text generation">
            <SettingRow
                label="Model"
                description="Writes chat titles and other short labels; a small one is quick and cheap"
                keywords="text generation model title haiku sonnet opus label"
                setting={model}
                controlClassName="w-44"
                control={
                    <Select
                        aria-label="Text generation model"
                        value={value}
                        options={options}
                        onValueChange={(next) => model.set(next === "default" ? "" : next)}
                    />
                }
            />
        </SettingsSection>
    );
}

function TitlesSection() {
    const autoTitle = useSetting("chat", "autoTitle");

    return (
        <SettingsSection title="Titles">
            <SwitchRow
                label="Name chats automatically"
                description="Titled from its first prompt; off, its first words name it"
                keywords="title auto name chat rename generate"
                setting={autoTitle}
            />
        </SettingsSection>
    );
}
