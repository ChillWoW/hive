import type { Catalog, ChatConfig, HarnessId } from "@/proto";
import { useComposerStore } from "@/features/composer/store";
import { defaultConfig, ModelPicker, useCatalog } from "@/features/models";
import { SegmentedControl, Select } from "@/ui";
import { SettingRow, SettingsSection, SwitchRow } from "../SettingsSection";
import { useSetting, useSettingsStore } from "../store";
import {
    DEFAULT_SETTINGS,
    type BusySend,
    type DiffIndicators,
    type DiffStyle,
    type InlineChanges,
    type ToolCalls,
    type TranscriptWidth
} from "../types";

export function ChatsPage() {
    return (
        <>
            <DefaultsSection />
            <SendingSection />
            <TranscriptSection />
            <DiffsSection />
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

const TOOL_CALLS: { value: ToolCalls; label: string }[] = [
    { value: "all", label: "Show all" },
    { value: "hide-successful", label: "Hide successful" },
    { value: "final-only", label: "Final reply only" }
];

function TranscriptSection() {
    const reasoning = useSetting("chat", "reasoningExpanded");
    const toolOutput = useSetting("chat", "toolOutputExpanded");
    const toolCalls = useSetting("chat", "toolCalls");
    const compact = useSetting("chat", "compactTranscript");
    const width = useSetting("chat", "transcriptWidth");

    return (
        <SettingsSection title="Transcript">
            <SettingRow
                label="Width"
                description="How wide the transcript and composer may grow"
                keywords="transcript width narrow wide full column lane max"
                setting={width}
                controlClassName="w-auto"
                control={
                    <SegmentedControl
                        size="xs"
                        value={width.value}
                        onValueChange={(value) => width.set(value as TranscriptWidth)}
                        aria-label="Transcript width"
                    >
                        <SegmentedControl.Item value="narrow">Narrow</SegmentedControl.Item>
                        <SegmentedControl.Item value="default">Default</SegmentedControl.Item>
                        <SegmentedControl.Item value="wide">Wide</SegmentedControl.Item>
                        <SegmentedControl.Item value="full">Full</SegmentedControl.Item>
                    </SegmentedControl>
                }
            />
            <SwitchRow
                label="Compact"
                description="Less space between and inside turns"
                keywords="compact dense density spacing tight transcript"
                setting={compact}
            />
            <SettingRow
                label="Tool calls"
                description="Which of a turn's steps the transcript shows"
                keywords="tool calls visibility hide successful failed final reply only answer thinking transcript"
                setting={toolCalls}
                controlClassName="w-44"
                control={
                    <Select
                        items={TOOL_CALLS}
                        value={toolCalls.value}
                        onValueChange={(next: ToolCalls | null) => next && toolCalls.set(next)}
                    >
                        <Select.Trigger aria-label="Tool calls">
                            <Select.Value />
                        </Select.Trigger>
                        <Select.Content>
                            {TOOL_CALLS.map((option) => (
                                <Select.Item key={option.value} value={option.value}>
                                    {option.label}
                                </Select.Item>
                            ))}
                        </Select.Content>
                    </Select>
                }
            />
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

function DiffsSection() {
    const wrap = useSetting("diffs", "wrapLines");
    const indicators = useSetting("diffs", "indicators");
    const inline = useSetting("diffs", "inlineChanges");
    const style = useSetting("diffs", "style");

    return (
        <SettingsSection title="Diffs">
            <SettingRow
                label="Changes layout"
                description="How the changes tab shows a diff"
                keywords="diff split unified side by side columns layout changes tab"
                setting={style}
                controlClassName="w-auto"
                control={
                    <SegmentedControl
                        size="xs"
                        value={style.value}
                        onValueChange={(value) => style.set(value as DiffStyle)}
                        aria-label="Changes layout"
                    >
                        <SegmentedControl.Item value="unified">Unified</SegmentedControl.Item>
                        <SegmentedControl.Item value="split">Split</SegmentedControl.Item>
                    </SegmentedControl>
                }
            />
            <SwitchRow
                label="Wrap lines"
                description="Long lines wrap rather than scroll sideways"
                keywords="diff wrap lines overflow scroll long"
                setting={wrap}
            />
            <SettingRow
                label="Change markers"
                description="How added and removed lines are marked"
                keywords="diff indicators markers plus minus bars gutter"
                setting={indicators}
                controlClassName="w-auto"
                control={
                    <SegmentedControl
                        size="xs"
                        value={indicators.value}
                        onValueChange={(value) => indicators.set(value as DiffIndicators)}
                        aria-label="Change markers"
                    >
                        <SegmentedControl.Item value="classic">+ / −</SegmentedControl.Item>
                        <SegmentedControl.Item value="bars">Bars</SegmentedControl.Item>
                        <SegmentedControl.Item value="none">None</SegmentedControl.Item>
                    </SegmentedControl>
                }
            />
            <SettingRow
                label="Inline changes"
                description="Highlight what changed inside a line"
                keywords="diff inline word character highlight changes"
                setting={inline}
                controlClassName="w-auto"
                control={
                    <SegmentedControl
                        size="xs"
                        value={inline.value}
                        onValueChange={(value) => inline.set(value as InlineChanges)}
                        aria-label="Inline changes"
                    >
                        <SegmentedControl.Item value="word">Words</SegmentedControl.Item>
                        <SegmentedControl.Item value="char">Characters</SegmentedControl.Item>
                        <SegmentedControl.Item value="off">Off</SegmentedControl.Item>
                    </SegmentedControl>
                }
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
    const suggestions = useSetting("chat", "promptSuggestions");

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
            <SwitchRow
                label="Suggest next prompt"
                description="Tab takes the agent's guess at your next message"
                keywords="prompt suggestion tab complete autocomplete next message predict"
                setting={suggestions}
            />
        </SettingsSection>
    );
}
