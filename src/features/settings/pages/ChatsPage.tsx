import type { Catalog, ChatConfig, HarnessId } from "@/proto";
import { useComposerStore } from "@/features/composer/store";
import { defaultConfig, ModelPicker, useCatalog } from "@/features/models";
import { Select } from "@/ui";
import { SettingRow, SettingsSection, SwitchRow } from "../SettingsSection";
import { useSetting, useSettingsStore } from "../store";
import { DEFAULT_SETTINGS, type BusySend } from "../types";

export function ChatsPage() {
    return (
        <>
            <DefaultsSection />
            <SendingSection />
            <TranscriptSection />
            <TitlesSection />
            <TextGenerationSection />
        </>
    );
}

/** The composer's model chip as a form control; text sized like `Select`'s trigger. */
const PICKER_TRIGGER = "h-7 rounded-md border border-border bg-raised text-[13px] text-text";

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
                        triggerClassName={PICKER_TRIGGER}
                        harnesses={CLAUDE_ONLY}
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

/**
 * The catalog id a stored text model shows as: an id as it is, an alias
 * (`haiku`) as the newest model it names (the catalog lists newest first),
 * empty as Claude's default.
 */
function textModelId(catalog: Catalog | null, stored: string): string | undefined {
    if (!stored) return undefined;
    const models = catalog?.models ?? [];
    return (
        models.find((m) => m.id === stored)?.id ??
        models.find((m) => m.id.startsWith(`claude-${stored}-`))?.id ??
        stored
    );
}

/** The defaults and text runs are Claude's (`chat.*` settings name its models). */
const CLAUDE_ONLY: HarnessId[] = ["claude"];

function TextGenerationSection() {
    const model = useSetting("chat", "textGenerationModel");
    const catalog = useCatalog();
    const config: ChatConfig = {
        harness: "claude",
        model: textModelId(catalog, model.value),
        modelOptions: {},
        access: "full-access",
        plan: false
    };

    return (
        <SettingsSection title="Text generation">
            <SettingRow
                label="Model"
                description="Writes chat titles and short labels; small is quick and cheap"
                keywords="text generation model title haiku sonnet opus label"
                setting={model}
                control={
                    <ModelPicker
                        config={config}
                        onChange={(next) => next.model && model.set(next.model)}
                        placement="bottom"
                        triggerClassName={PICKER_TRIGGER}
                        modelOnly
                        harnesses={CLAUDE_ONLY}
                    />
                }
            />
        </SettingsSection>
    );
}

function TranscriptSection() {
    const reasoning = useSetting("chat", "reasoningExpanded");
    const toolOutput = useSetting("chat", "toolOutputExpanded");

    return (
        <SettingsSection title="Transcript">
            <SwitchRow
                label="Expand thinking"
                description="Show the agent's thoughts in full rather than a one-line preview"
                keywords="reasoning thinking thoughts expand collapse transcript"
                setting={reasoning}
            />
            <SwitchRow
                label="Expand tool output"
                description="Show each tool call's output, diff or command open"
                keywords="tool output expand collapse transcript diff command"
                setting={toolOutput}
            />
        </SettingsSection>
    );
}

const BUSY_SEND: { value: BusySend; label: string }[] = [
    { value: "queue", label: "Queue" },
    { value: "after-tool", label: "Steer" },
    { value: "interrupt", label: "Interrupt" }
];

function SendingSection() {
    const busySend = useSetting("chat", "busySend");

    return (
        <SettingsSection title="Sending">
            <SettingRow
                label="While the agent works"
                description="When a prompt sent mid-turn reaches the agent"
                keywords="busy send queue steer interrupt follow up while working after tool call"
                setting={busySend}
                controlClassName="w-44"
                control={
                    <Select
                        items={BUSY_SEND}
                        value={busySend.value}
                        onValueChange={(next: BusySend | null) => next && busySend.set(next)}
                    >
                        <Select.Trigger aria-label="While the agent works">
                            <Select.Value />
                        </Select.Trigger>
                        <Select.Content>
                            {BUSY_SEND.map((option) => (
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
