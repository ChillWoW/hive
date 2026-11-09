/**
 * Mirror of `src-tauri/src/settings/schema.rs`; change both together.
 */

export type UpdateChannel = "stable" | "prerelease";

export type UpdatesSettings = {
    autoCheck: boolean;
    channel: UpdateChannel;
};

export type Settings = {
    version: number;
    updates: UpdatesSettings;
};

export const DEFAULT_SETTINGS: Settings = {
    version: 1,
    updates: {
        autoCheck: true,
        channel: "stable"
    }
};
