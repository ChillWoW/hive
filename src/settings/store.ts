import { create } from "zustand";
import { DEFAULT_SETTINGS, type Settings } from "@/proto";
import {
    mergeSettings,
    settingsApi,
    type SectionId,
    type SettingsPatch,
    type SettingsSections
} from "./api";

export type SettingsPageId = "chats" | "notifications" | "keyboard" | "about";

type SettingsState = {
    settings: Settings;

    /** Modal UI state; not persisted. */
    isOpen: boolean;
    page: SettingsPageId;
    setOpen: (open: boolean) => void;
    open: (page?: SettingsPageId) => void;
    toggle: () => void;
    setPage: (page: SettingsPageId) => void;

    /** Optimistic: the UI updates now, Rust's answer wins when it lands. */
    update: (patch: SettingsPatch) => Promise<void>;
    resetAll: () => Promise<void>;
};

/**
 * Writes go out one at a time, in order, so a fast toggle-toggle can't land
 * out of order. While any are in flight, broadcasts are ignored: they carry
 * an older document than the optimistic one on screen, and the last write's
 * response brings the final state anyway.
 */
let queue: Promise<unknown> = Promise.resolve();
let pending = 0;

export const useSettingsStore = create<SettingsState>()((set, get) => {
    const enqueue = (write: () => Promise<Settings>): Promise<void> => {
        pending++;

        const run = queue
            .then(write)
            .then(
                (stored) => {
                    if (--pending > 0) return;
                    set({ settings: stored });
                },
                async (error: unknown) => {
                    --pending;
                    console.warn("[settings] save failed", error);
                    // Optimistic state may now be a lie; resync from disk.
                    if (pending === 0) {
                        const stored = await settingsApi.get().catch(() => null);
                        if (stored) set({ settings: stored });
                    }
                }
            );
        queue = run;
        return run;
    };

    return {
        settings: DEFAULT_SETTINGS,

        isOpen: false,
        page: "chats",
        setOpen: (isOpen) => set({ isOpen }),
        open: (page) => set((s) => ({ isOpen: true, page: page ?? s.page })),
        toggle: () => set((s) => ({ isOpen: !s.isOpen })),
        setPage: (page) => set({ page }),

        update: (patch) => {
            set({ settings: mergeSettings(get().settings, patch) });
            return enqueue(() => settingsApi.update(patch));
        },

        resetAll: () => {
            set({ settings: DEFAULT_SETTINGS });
            return enqueue(settingsApi.reset);
        }
    };
});

let hydration: Promise<void> | null = null;

/** Loads once and follows broadcasts; safe to call repeatedly. */
export function hydrateSettings(): Promise<void> {
    hydration ??= (async () => {
        try {
            const settings = await settingsApi.get();
            useSettingsStore.setState({ settings });
            await settingsApi.onChanged((next) => {
                if (pending === 0) useSettingsStore.setState({ settings: next });
            });
        } catch (error) {
            // Let a later call retry.
            hydration = null;
            console.warn("[settings] load failed", error);
        }
    })();
    return hydration;
}

/** Re-reads settings.json (hand edits); a change arrives as a broadcast. */
export function reloadSettings(): void {
    if (pending > 0) return;
    settingsApi.reload().catch(() => {});
}

function equal(a: unknown, b: unknown): boolean {
    return a === b || JSON.stringify(a) === JSON.stringify(b);
}

/**
 * One setting, everything a row needs:
 *
 * ```tsx
 * const confirm = useSetting("chats", "confirmDelete");
 * <SettingRow label="Confirm before deleting" setting={confirm} control={<Switch checked={confirm.value} onCheckedChange={confirm.set} />} />
 * ```
 */
export function useSetting<S extends SectionId, K extends keyof SettingsSections[S]>(
    section: S,
    key: K
) {
    type Value = SettingsSections[S][K];
    const value = useSettingsStore(
        (s) => (s.settings[section] as SettingsSections[S])[key]
    );
    const update = useSettingsStore((s) => s.update);
    const fallback = (DEFAULT_SETTINGS[section] as SettingsSections[S])[key];

    const patch = (next: Value) =>
        ({ [section]: { [key]: next } }) as SettingsPatch;

    return {
        value,
        defaultValue: fallback,
        modified: !equal(value, fallback),
        set: (next: Value) => void update(patch(next)),
        reset: () => void update(patch(fallback))
    };
}

export type SettingHandle = Pick<
    ReturnType<typeof useSetting>,
    "modified" | "reset"
>;

/** Same actions outside React. */
export const settings = {
    get: () => useSettingsStore.getState().settings,
    update: (patch: SettingsPatch) =>
        useSettingsStore.getState().update(patch),
    open: (page?: SettingsPageId) => useSettingsStore.getState().open(page),
    toggle: () => useSettingsStore.getState().toggle()
};
