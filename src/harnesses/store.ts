import { useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import type {
    ChatConfig,
    HarnessCatalog,
    HarnessId,
    Model,
    SlashCommand
} from "@/proto";
import { isTauri } from "@/lib/platform";

/**
 * What each harness offers (`Harness::catalog` in Rust): models, built-in
 * slash commands, sandbox levels, capabilities. Fetched at launch and again
 * whenever a picker opens, since `installed` can change while Hive runs.
 */

/** Under a plain `bun run dev` there's no engine; the pickers still need something to show. */
const BROWSER_CATALOGS: HarnessCatalog[] = [
    {
        id: "claude-code",
        label: "Claude Code",
        installed: true,
        models: [
            {
                id: "default",
                label: "Default",
                description: "The model Claude Code recommends for your account",
                reasoningLevels: ["low", "medium", "high", "xhigh", "max"],
                options: []
            },
            {
                id: "opus",
                label: "Opus",
                description: "Most capable, for complex work",
                reasoningLevels: ["low", "medium", "high", "xhigh", "max"],
                options: []
            },
            {
                id: "haiku",
                label: "Haiku",
                description: "Fastest, for quick answers",
                reasoningLevels: [],
                options: []
            }
        ],
        defaultModel: "default",
        commands: [
            {
                name: "compact",
                description: "Summarize the conversation to free up context"
            }
        ],
        sandboxLevels: ["workspace-write", "read-only", "danger-full-access"],
        capabilities: { steering: false, interrupt: true, attachments: false }
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

/** The harnesses pickers offer. */
export function useCatalogs(): HarnessCatalog[] {
    const catalogs = useHarnessesStore((s) => s.catalogs);
    return useMemo(() => catalogs.filter(shown), [catalogs]);
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

/**
 * `config` made valid for `catalog`: a model it has, a reasoning level that
 * model takes, a sandbox level it supports. Used when switching harness or
 * model, and on remembered new-chat settings that went stale.
 */
export function fitConfig(
    catalog: HarnessCatalog,
    config: ChatConfig
): ChatConfig {
    const model = resolveModel(catalog, config);
    const reasoning =
        config.reasoning && model?.reasoningLevels.includes(config.reasoning)
            ? config.reasoning
            : undefined;
    const sandbox = catalog.sandboxLevels.includes(config.sandbox)
        ? config.sandbox
        : (catalog.sandboxLevels[0] ?? config.sandbox);
    return {
        harness: catalog.id,
        model: model?.id,
        reasoning,
        modelOptions: config.harness === catalog.id ? config.modelOptions : {},
        sandbox
    };
}

/** A live session's own list when it has one, else the harness's built-ins. */
export function slashCommands(
    catalog: HarnessCatalog | undefined,
    live: SlashCommand[] | undefined
): SlashCommand[] {
    return live?.length ? live : (catalog?.commands ?? []);
}
