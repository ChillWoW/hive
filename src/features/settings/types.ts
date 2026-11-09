/**
 * Mirror of `src-tauri/src/settings/schema.rs`; change both together.
 */

export type AppearanceSettings = {
    /** A theme's name; see `src/features/theme/themes.ts`. */
    theme: string;
};

export type UpdateChannel = "stable" | "prerelease";

export type UpdatesSettings = {
    autoCheck: boolean;
    channel: UpdateChannel;
};

export type Settings = {
    version: number;
    appearance: AppearanceSettings;
    updates: UpdatesSettings;
};

export const DEFAULT_SETTINGS: Settings = {
    version: 1,
    appearance: {
        theme: "Hive Slate"
    },
    updates: {
        autoCheck: true,
        channel: "stable"
    }
};
