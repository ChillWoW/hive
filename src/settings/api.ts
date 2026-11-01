import { listen } from "@tauri-apps/api/event";
import { DEFAULT_SETTINGS, type Settings } from "@/proto";
import { backend } from "@/lib/backend";
import { isTauri } from "@/lib/platform";

/**
 * Transport for the settings document. Rust owns it (`hive_store::SettingsFile`):
 * it validates, clamps and writes `settings.json`, and broadcasts every change.
 * Under a plain `bun run dev` there is no backend, so the document lives in
 * localStorage instead and the UI still works end to end.
 */

/** Settings minus `version`, the part a patch can touch. */
export type SettingsSections = Omit<Settings, "version">;
export type SectionId = keyof SettingsSections;

export type SettingsPatch = {
    [S in SectionId]?: Partial<SettingsSections[S]>;
};

const CHANGED = "settings://changed";
const BROWSER_KEY = "hive.settings";

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Immutable deep merge, the same shape `Settings::sanitize` applies in Rust. */
export function mergeSettings<T>(base: T, patch: unknown): T {
    if (!isObject(base) || !isObject(patch)) return base;
    const result: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(patch)) {
        if (value === undefined || !(key in base)) continue;
        const current = result[key];
        result[key] =
            isObject(current) && isObject(value)
                ? mergeSettings(current, value)
                : value;
    }
    return result as T;
}

const browser = {
    read(): Settings {
        try {
            const raw = localStorage.getItem(BROWSER_KEY);
            return raw
                ? mergeSettings(DEFAULT_SETTINGS, JSON.parse(raw))
                : DEFAULT_SETTINGS;
        } catch {
            return DEFAULT_SETTINGS;
        }
    },
    write(settings: Settings): Settings {
        try {
            localStorage.setItem(BROWSER_KEY, JSON.stringify(settings));
        } catch {
            // Storage blocked: keep going in memory for this session.
        }
        return settings;
    }
};

export const settingsApi = {
    get: (): Promise<Settings> => backend("settings_get", undefined, browser.read),

    /** Returns what was stored, which may differ from the patch (clamping). */
    update: (patch: SettingsPatch): Promise<Settings> =>
        backend("settings_update", { patch }, () =>
            browser.write(mergeSettings(browser.read(), patch))
        ),

    reset: (): Promise<Settings> =>
        backend("settings_reset", undefined, () => browser.write(DEFAULT_SETTINGS)),

    /** Picks up hand edits to settings.json. */
    reload: (): Promise<Settings> => backend("settings_reload", undefined, browser.read),

    path: (): Promise<string | null> => backend("settings_path", undefined, () => null),

    reveal: (): Promise<void> => backend("settings_reveal", undefined, () => undefined),

    /** Where worktrees go while `worktrees.location` is empty. */
    defaultWorktreesDir: (): Promise<string> =>
        backend("worktrees_default_dir", undefined, () => "~/.hive/worktrees"),

    /** Every change from any window, including this one. */
    onChanged: async (
        handler: (settings: Settings) => void
    ): Promise<() => void> => {
        if (!isTauri) return () => {};
        return listen<Settings>(CHANGED, (event) => handler(event.payload));
    }
};
