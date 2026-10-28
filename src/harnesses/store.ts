import { useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import type {
    AccessMode,
    ChatConfig,
    HarnessCatalog,
    HarnessId,
    Model,
    ProvidersSettings,
    ReasoningLevel,
    SlashCommand
} from "@/proto";
import { isTauri } from "@/lib/platform";
import { useSettingsStore } from "@/settings/store";
import { ACCESS_MODES } from "./labels";

/**
 * What each harness offers (`Harness::catalog` in Rust): models, built-in
 * slash commands, capabilities. Fetched at launch and again
 * whenever a picker opens, since `installed` can change while Hive runs.
 */

/** Under a plain `bun run dev` there's no engine; the pickers still need something to show. */
const BROWSER_CATALOGS: HarnessCatalog[] = [
    {
        id: "claude-code",
        label: "Claude Code",
        installed: true,
        // Mirrors the Claude harness's catalog (crates/harness/src/claude/mod.rs).
        models: (
            [
                ["claude-opus-5-5", "Opus 5.5", "Best for everyday, complex tasks"],
                ["claude-fable-5-1", "Fable 5.1", "Most intelligent model for building agents"],
                ["claude-sonnet-5-5", "Sonnet 5.5", "Most efficient for simpler tasks"],
                ["claude-haiku-5-5", "Haiku 5.5", "Fastest for quick answers"],
                ["claude-fable-5", "Fable 5", "Previous generation Fable"],
                ["claude-opus-5", "Opus 5", "Previous generation Opus"],
                ["claude-opus-4-8", "Opus 4.8", "Older generation Opus"],
                ["claude-sonnet-5", "Sonnet 5", "Previous generation Sonnet"],
                ["claude-haiku-4-5", "Haiku 4.5", "Previous generation Haiku"]
            ] as const
        ).map(([id, label, description]) => ({
            id,
            label,
            description,
            reasoningLevels:
                id === "claude-haiku-4-5" ? [] : ["low", "medium", "high", "xhigh", "max"],
            options: []
        })),
        defaultModel: "claude-opus-5-5",
        commands: [
            {
                name: "compact",
                description: "Summarize the conversation to free up context"
            }
        ],
        accessModes: ["supervised", "auto-accept-edits", "full-access"],
        capabilities: { steering: false, interrupt: true, attachments: false, plan: true }
    }
];

type HarnessesState = {
    /** Registration order. Includes Mock; `useCatalogs` decides what pickers show. */
    catalogs: HarnessCatalog[];
    loaded: boolean;
};

export const useHarnessesStore = create<HarnessesState>()(() => ({
    catalogs: [],
    loaded: false
}));

let inflight: Promise<void> | null = null;

/** Fetches the catalogs; concurrent calls share one request. */
export function refreshCatalogs(): Promise<void> {
    inflight ??= (
        isTauri
            ? invoke<HarnessCatalog[]>("list_harnesses")
            : Promise.resolve(BROWSER_CATALOGS)
    )
        .then(
            (catalogs) => useHarnessesStore.setState({ catalogs, loaded: true }),
            (error: unknown) => {
                console.warn("[harnesses] listing failed", error);
                useHarnessesStore.setState({ loaded: true });
            }
        )
        .finally(() => {
            inflight = null;
        });
    return inflight;
}

/** Mock plays a scripted turn; it's for building the UI, not for users. */
const shown = (c: HarnessCatalog) => c.id !== "mock" || import.meta.env.DEV;

/** Every harness the user can see, on or off: what Settings › Providers lists. */
export function useHarnesses(): HarnessCatalog[] {
    const catalogs = useHarnessesStore((s) => s.catalogs);
    return useMemo(() => catalogs.filter(shown), [catalogs]);
}

/** `claude-code` → `claudeCode`, its key in the `providers` settings section. */
export function providerKey(id: HarnessId): string {
    return id.replace(/-(\w)/g, (_, c: string) => c.toUpperCase());
}

/** Turned on in Settings › Providers; a harness with no switch counts as on. */
export function isEnabled(providers: ProvidersSettings, id: HarnessId): boolean {
    return (providers as Record<string, boolean | undefined>)[providerKey(id)] ?? true;
}

/**
 * The harnesses pickers offer: those turned on. If a hand-edited settings
 * file turns them all off, all of them, so a new chat still has one.
 */
export function useCatalogs(): HarnessCatalog[] {
    const harnesses = useHarnesses();
    const providers = useSettingsStore((s) => s.settings.providers);
    return useMemo(() => {
        const on = harnesses.filter((c) => isEnabled(providers, c.id));
        return on.length > 0 ? on : harnesses;
    }, [harnesses, providers]);
}

export function useCatalog(id: HarnessId | undefined) {
    return useHarnessesStore((s) =>
        id ? s.catalogs.find((c) => c.id === id) : undefined
    );
}

/** The model a config runs on: its own pick, else the harness default, else the first. */
export function resolveModel(
    catalog: HarnessCatalog | undefined,
    config: ChatConfig
): Model | undefined {
    if (!catalog) return undefined;
    const id = config.model ?? catalog.defaultModel;
    return catalog.models.find((m) => m.id === id) ?? catalog.models[0];
}

/** A model's effort when none is picked: High, else Medium, else its first level. */
export function defaultReasoning(model: Model | undefined): ReasoningLevel | undefined {
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

/**
 * `config` made valid for `catalog`: a model it has, a reasoning level that
 * model takes (its default when none is picked), an access mode the harness honors, plan mode only where it
 * has one. Used when switching harness or model, and on remembered new-chat
 * settings that went stale. The sandbox level is kept as is; nothing in the
 * UI picks it.
 */
export function fitConfig(
    catalog: HarnessCatalog,
    config: ChatConfig
): ChatConfig {
    const model = resolveModel(catalog, config);
    return {
        harness: catalog.id,
        model: model?.id,
        reasoning: resolveReasoning(model, config),
        modelOptions: config.harness === catalog.id ? config.modelOptions : {},
        sandbox: config.sandbox,
        access: resolveAccess(config.access, catalog.accessModes),
        plan: config.plan && catalog.capabilities.plan
    };
}

/**
 * The mode a run gets when `wanted` isn't among those the harness `offered`:
 * the most trusting offered mode that still asks at least as much. A harness
 * with nothing that asks as much runs in its least trusting mode — for an
 * agent that can't ask at all, full access, which the chip then shows.
 */
export function resolveAccess(wanted: AccessMode, offered: AccessMode[]): AccessMode {
    if (offered.length === 0) return "full-access";
    if (offered.includes(wanted)) return wanted;
    const rank = (mode: AccessMode) => ACCESS_MODES.indexOf(mode);
    const asking = offered.filter((mode) => rank(mode) <= rank(wanted));
    if (asking.length === 0) return offered[0]!;
    return asking.reduce((best, mode) => (rank(mode) > rank(best) ? mode : best));
}

/** A live session's own list when it has one, else the harness's built-ins. */
export function slashCommands(
    catalog: HarnessCatalog | undefined,
    live: SlashCommand[] | undefined
): SlashCommand[] {
    return live?.length ? live : (catalog?.commands ?? []);
}
