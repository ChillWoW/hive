import type { ChatConfig } from "@/proto";
import { useComposerStore } from "@/features/composer/store";
import { defaultConfig, ModelPicker } from "@/features/models";
import { Select } from "@/ui";
import { SettingRow, SettingsSection, SwitchRow } from "../SettingsSection";
import { useSetting, useSettingsStore } from "../store";
import { DEFAULT_SETTINGS } from "../types";

export function ChatsPage() {
    return (
        <>
            <DefaultsSection />
            <TitlesSection />
            <TextGenerationSection />
        </>
    );
}

/**
 * The model, effort and fast mode a new chat starts on, in the composer's own
 * picker. A change also forgets the new-chat view's last pick, so the next
 * chat starts on it.
 */
function DefaultsSection() {
    const chat = useSettingsStore((s) => s.settings.chat);
    const update = useSettingsStore((s) => s.update);
    const defaults = DEFAULT_SETTINGS.chat;
    const set = (patch: Partial<typeof chat>) => {
        void update({ chat: patch });
        useComposerStore.getState().setNewChatConfig(null);
    };
    const onChange = (config: ChatConfig) =>
        set({
            defaultModel: config.model ?? defaults.defaultModel,
            defaultEffort: config.reasoning ?? chat.defaultEffort,
            defaultFastMode: config.modelOptions.fastMode === "on"
        });
    const setting = {
        modified:
            chat.defaultModel !== defaults.defaultModel ||
            chat.defaultEffort !== defaults.defaultEffort ||
            chat.defaultFastMode !== defaults.defaultFastMode,
        reset: () =>
            set({
                defaultModel: defaults.defaultModel,
                defaultEffort: defaults.defaultEffort,
                defaultFastMode: defaults.defaultFastMode
            })
    };

    return (
        <SettingsSection title="Defaults">
            <SettingRow
                label="Model"
                description="What new chats start on; each chat can switch in its composer"
                keywords="default model effort reasoning fast mode opus sonnet haiku fable"
                setting={setting}
                control={
                    <ModelPicker
                        config={defaultConfig(chat)}
                        onChange={onChange}
                        placement="bottom"
                        triggerClassName="h-7 rounded-md border border-border bg-raised text-text"
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

/** Claude's aliases; its default as "default" (stored empty). */
const MODELS: { value: string; label: string }[] = [
    { value: "haiku", label: "Haiku" },
    { value: "sonnet", label: "Sonnet" },
    { value: "opus", label: "Opus" },
    { value: "default", label: "Claude's default" }
];

function TextGenerationSection() {
    const model = useSetting("chat", "textGenerationModel");
    const value = model.value || "default";
    // An id typed into settings.json is offered as it is.
    const options = MODELS.some((o) => o.value === value) ? MODELS : [...MODELS, { value, label: value }];

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
                        items={options}
                        value={value}
                        onValueChange={(next) => {
                            if (next !== null) model.set(next === "default" ? "" : next);
                        }}
                    >
                        <Select.Trigger aria-label="Text generation model">
                            <Select.Value />
                        </Select.Trigger>
                        <Select.Content>
                            {options.map((option) => (
                                <Select.Item key={option.value} value={option.value}>
                                    {option.label}
                                </Select.Item>
                            ))}
                        </Select.Content>
                    </Select>
                }
            />
        </SettingsSection>
    );
}
