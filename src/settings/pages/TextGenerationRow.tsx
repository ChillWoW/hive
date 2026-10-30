import type { ChatConfig, Model, ReasoningLevel } from "@/proto";
import { ModelPicker } from "@/composer";
import { resolveModel, useHarnessesStore } from "@/harnesses";
import { cn } from "@/lib/cn";
import { SettingRow } from "../SettingsSection";
import { useSetting, useSettingsStore } from "../store";

/** Least to most effort, as Rust orders `ReasoningLevel`. */
const EFFORT: ReasoningLevel[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

function lowest(model: Model | undefined): ReasoningLevel | undefined {
    const levels = model?.reasoningLevels ?? [];
    return EFFORT.find((level) => levels.includes(level));
}

/** `wanted` if the model takes it, else its lowest level: what the engine runs. */
function fitEffort(model: Model | undefined, wanted: ReasoningLevel | null | undefined) {
    return wanted && model?.reasoningLevels.includes(wanted) ? wanted : lowest(model);
}

/** The settings row's picker reads like a form field, not a composer chip. */
const triggerClassName = cn(
    "h-7 w-full justify-start rounded-md border border-dark-500 bg-dark-700 px-2 text-xs text-dark-50",
    "hover:border-dark-400 hover:bg-dark-700",
    "data-[popup-open]:border-dark-400 data-[popup-open]:bg-dark-700"
);

const BASE = {
    modelOptions: {},
    sandbox: "read-only",
    access: "supervised",
    plan: false
} satisfies Omit<ChatConfig, "harness">;

/**
 * Settings › Chats › Text generation: the model (and effort) Hive's own text
 * runs use — chat titles, for now. Nothing picked is automatic; the reset
 * marker goes back to it. The effort defaults to the model's lowest, as the
 * engine's does.
 */
export function TextGenerationRow() {
    const harness = useSetting("textGeneration", "harness");
    const model = useSetting("textGeneration", "model");
    const reasoning = useSetting("textGeneration", "reasoning");
    const catalogs = useHarnessesStore((s) => s.catalogs);
    const update = useSettingsStore((s) => s.update);

    const catalog = catalogs.find((c) => c.id === harness.value);
    const config: ChatConfig | null = harness.value
        ? (() => {
              const base = { ...BASE, harness: harness.value, model: model.value ?? undefined };
              return { ...base, reasoning: fitEffort(resolveModel(catalog, base), reasoning.value) };
          })()
        : null;

    const onChange = (next: ChatConfig) => {
        const switched = next.harness !== config?.harness || next.model !== config?.model;
        const picked = resolveModel(
            catalogs.find((c) => c.id === next.harness),
            next
        );
        // A new model keeps the effort it can, else starts at its lowest
        // (the picker would default to High).
        const effort = switched ? fitEffort(picked, config?.reasoning) : next.reasoning;
        void update({
            textGeneration: {
                harness: next.harness,
                model: picked?.id ?? next.model ?? null,
                reasoning: effort ?? null
            }
        });
    };

    const modified = harness.modified || model.modified || reasoning.modified;

    return (
        <SettingRow
            label="Model"
            description="Writes chat titles. Automatic: the chat's agent, smallest model"
            keywords="text generation title model reasoning effort auto automatic haiku mini cheap"
            setting={{
                modified,
                reset: () =>
                    void update({ textGeneration: { harness: null, model: null, reasoning: null } })
            }}
            control={
                <ModelPicker
                    config={config}
                    onChange={onChange}
                    fastMode={false}
                    placeholder="Automatic"
                    placement="bottom"
                    triggerClassName={triggerClassName}
                />
            }
        />
    );
}
