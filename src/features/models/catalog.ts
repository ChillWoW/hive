import { create } from "zustand";
import type { AccessMode, Catalog, ChatConfig, Model, ReasoningLevel } from "@/proto";
import type { ChatSettings } from "@/features/settings/types";
import { backend } from "@/lib/backend";

/**
 * Claude's models (`claude::catalog` in Rust), fetched at launch and again
 * whenever the model picker opens, since `installed` can change while the
 * app runs.
 */

export const REASONING_LABELS: Record<ReasoningLevel, string> = {
    low: "Low",
    medium: "Medium",
    high: "High",
    xhigh: "Extra high",
    max: "Max"
};

const EFFORTS: ReasoningLevel[] = ["low", "medium", "high", "xhigh", "max"];

const FAST_OPTION = {
    id: "fastMode",
    label: "Fast mode",
    choices: [
        { id: "off", label: "Off" },
        { id: "on", label: "On" }
    ],
    defaultChoice: "off"
};

/** `bun run dev` has no backend; mirrors `crates/harness/src/claude/models.rs`. */
const DEV_CATALOG: Catalog = {
    installed: true,
    models: (
        [
            ["claude-opus-5-5", "Opus 5.5", "Best for everyday, complex tasks"],
            ["claude-fable-5-2", "Fable 5.2", "Most intelligent model for building agents"],
            ["claude-sonnet-5-5", "Sonnet 5.5", "Most efficient for simpler tasks"],
            ["claude-haiku-5-5", "Haiku 5.5", "Fastest for quick answers"],
            ["claude-fable-5-1", "Fable 5.1", "Previous generation Fable"],
            ["claude-opus-5", "Opus 5", "Previous generation Opus"],
            ["claude-sonnet-5", "Sonnet 5", "Previous generation Sonnet"],
            ["claude-haiku-4-5", "Haiku 4.5", "Previous generation Haiku"]
        ] as const
    ).map(([id, label, description]) => ({
        id,
        label,
        description,
        reasoningLevels: id === "claude-haiku-4-5" ? [] : EFFORTS,
        options: id.startsWith("claude-opus-") ? [FAST_OPTION] : []
    })),
    defaultModel: "claude-opus-5-5"
};

export const useCatalogStore = create<{ catalog: Catalog | null }>()(() => ({ catalog: null }));

let listing: Promise<void> | null = null;

/** Fetches the catalog; concurrent calls share one request. */
export function refreshCatalog(): Promise<void> {
    listing ??= backend<Catalog>("claude_catalog", undefined, () => DEV_CATALOG)
        .then(
            (catalog) => useCatalogStore.setState({ catalog }),
            (error: unknown) => console.warn("[models] listing failed", error)
        )
        .finally(() => {
            listing = null;
        });
    return listing;
}

export const useCatalog = () => useCatalogStore((s) => s.catalog);

/** The model a config runs on: its own pick, else the default, else the first. */
export function resolveModel(catalog: Catalog | null, config: ChatConfig): Model | undefined {
    if (!catalog) return undefined;
    const id = config.model ?? catalog.defaultModel;
    return catalog.models.find((m) => m.id === id) ?? catalog.models[0];
}

/** A model's effort when none is picked: High, else Medium, else its first level. */
function defaultReasoning(model: Model | undefined): ReasoningLevel | undefined {
    const levels = model?.reasoningLevels ?? [];
    return levels.find((l) => l === "high") ?? levels.find((l) => l === "medium") ?? levels[0];
}

/** The effort a config runs at: its own pick if the model takes it, else the default. */
export function resolveReasoning(
    model: Model | undefined,
    config: ChatConfig
): ReasoningLevel | undefined {
    return config.reasoning && model?.reasoningLevels.includes(config.reasoning)
        ? config.reasoning
        : defaultReasoning(model);
}

/** The picks in `options` that `model` offers, each one of its choices. */
function fitOptions(
    model: Model | undefined,
    options: ChatConfig["modelOptions"]
): ChatConfig["modelOptions"] {
    const fitted: ChatConfig["modelOptions"] = {};
    for (const option of model?.options ?? []) {
        const value = options[option.id];
        if (value !== undefined && option.choices.some((c) => c.id === value)) {
            fitted[option.id] = value;
        }
    }
    return fitted;
}

const FAST_MODE = "fastMode";

/** Whether `model` offers fast mode (Opus). */
export function hasFastMode(model: Model | undefined): boolean {
    return !!model?.options.some((o) => o.id === FAST_MODE);
}

/** Whether `config` runs `model` in fast mode. */
export function isFastMode(model: Model | undefined, config: ChatConfig): boolean {
    return hasFastMode(model) && config.modelOptions[FAST_MODE] === "on";
}

/** `config` with fast mode turned `on` or off (off drops the pick). */
export function withFastMode(config: ChatConfig, on: boolean): ChatConfig {
    const { [FAST_MODE]: _, ...rest } = config.modelOptions;
    return { ...config, modelOptions: on ? { ...rest, [FAST_MODE]: "on" } : rest };
}

/**
 * `config` made valid for `catalog`: a model it has, a level that model
 * takes (its default when none fits), only options that model offers. Used
 * when switching model, and on remembered configs that went stale.
 */
export function fitConfig(catalog: Catalog, config: ChatConfig): ChatConfig {
    const model = resolveModel(catalog, config);
    return {
        ...config,
        model: model?.id,
        reasoning: resolveReasoning(model, config),
        modelOptions: fitOptions(model, config.modelOptions),
        // Remembered before access and plan mode existed.
        access: config.access ?? "full-access",
        plan: config.plan ?? false
    };
}

/** What Settings › Chats says a new chat starts on. */
export function defaultConfig(settings: ChatSettings, access: AccessMode = "full-access"): ChatConfig {
    return {
        model: settings.defaultModel,
        reasoning: settings.defaultEffort,
        modelOptions: settings.defaultFastMode ? { [FAST_MODE]: "on" } : {},
        access,
        plan: false
    };
}
