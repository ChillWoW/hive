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

/** Which key sends a prompt from the composer; the other one adds a line. */
export type SendKey = "enter" | "mod-enter";

/**
 * Shortcuts, read by `src/keybindings/`. Each is a combo like `Mod+Shift+P`
 * (`Mod`: Cmd on macOS, Ctrl elsewhere); empty or unparsable means unbound.
 */
export type KeyboardSettings = {
    sendWith: SendKey;
    commandPalette: string;
    newChat: string;
    toggleSidebar: string;
    openSettings: string;
    openUsage: string;
    chatDetails: string;
    focusComposer: string;
    previousChat: string;
    nextChat: string;
    goBack: string;
    goForward: string;
    archiveChat: string;
    findInChat: string;
    newTerminal: string;
    openDiff: string;
    openHistory: string;
    toggleFilePanel: string;
    toggleRightSidebar: string;
    searchFiles: string;
    searchInFiles: string;
    closeTab: string;
    togglePlan: string;
    sendInBackground: string;
};

export type Settings = {
    version: number;
    appearance: AppearanceSettings;
    updates: UpdatesSettings;
    keyboard: KeyboardSettings;
};

export const DEFAULT_SETTINGS: Settings = {
    version: 1,
    appearance: {
        theme: "Outcode Slate"
    },
    updates: {
        autoCheck: true,
        channel: "stable"
    },
    keyboard: {
        sendWith: "enter",
        commandPalette: "Mod+K",
        newChat: "Mod+N",
        toggleSidebar: "Mod+B",
        openSettings: "Mod+,",
        openUsage: "Mod+U",
        chatDetails: "Mod+I",
        focusComposer: "Mod+L",
        previousChat: "Ctrl+Shift+Tab",
        nextChat: "Ctrl+Tab",
        goBack: "Alt+Left",
        goForward: "Alt+Right",
        archiveChat: "Mod+Shift+A",
        findInChat: "Mod+F",
        newTerminal: "Mod+J",
        openDiff: "Mod+Shift+G",
        openHistory: "Mod+Shift+H",
        toggleFilePanel: "Mod+Shift+E",
        toggleRightSidebar: "Mod+Alt+B",
        searchFiles: "Mod+P",
        searchInFiles: "Mod+Shift+F",
        closeTab: "Mod+W",
        togglePlan: "Shift+Tab",
        sendInBackground: "Mod+Shift+Enter"
    }
};
