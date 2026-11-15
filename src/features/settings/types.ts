/**
 * Mirror of `src-tauri/src/settings/schema.rs`; change both together.
 */

export type AppearanceSettings = {
    /** A theme's name; see `src/features/theme/themes.ts`. */
    theme: string;
    /** A font family: the bundled default or an installed one; see `src/features/fonts/`. */
    fontFamily: string;
};

export type UpdateChannel = "stable" | "prerelease";

export type UpdatesSettings = {
    autoCheck: boolean;
    channel: UpdateChannel;
};

/**
 * Shortcuts, read by `src/keybindings/`. Each is a combo like `Mod+Shift+P`
 * (`Mod`: Cmd on macOS, Ctrl elsewhere); empty or unparsable means unbound.
 */
export type KeyboardSettings = {
    openSettings: string;
    toggleSidebar: string;
    toggleRightSidebar: string;
    toggleFilePanel: string;
};

export type ClaudeSettings = {
    /** The `claude` executable; empty finds it on PATH or in its install folders. */
    binaryPath: string;
};

export type Settings = {
    version: number;
    appearance: AppearanceSettings;
    updates: UpdatesSettings;
    keyboard: KeyboardSettings;
    claude: ClaudeSettings;
};

export const DEFAULT_SETTINGS: Settings = {
    version: 1,
    appearance: {
        theme: "Outcode Slate",
        fontFamily: "Geist"
    },
    updates: {
        autoCheck: true,
        channel: "stable"
    },
    keyboard: {
        openSettings: "Mod+,",
        toggleSidebar: "Mod+B",
        toggleRightSidebar: "Mod+Alt+B",
        toggleFilePanel: "Mod+Shift+E"
    },
    claude: {
        binaryPath: ""
    }
};
