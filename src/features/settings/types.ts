/**
 * Mirror of `src-tauri/src/settings/schema.rs`; change both together.
 */

import type { ReasoningLevel } from "@/proto";

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

export type ChatSettings = {
    /** The model a new chat starts on (a catalog id). */
    defaultModel: string;
    /** The effort a new chat starts at, where its model takes one. */
    defaultEffort: ReasoningLevel;
    /** New chats on a model with fast mode start with it on. */
    defaultFastMode: boolean;
    /** Minutes an agent process is kept between prompts (1–1440); the next prompt resumes it. */
    idleTimeoutMinutes: number;
    /** Name a chat with a short text run on its first prompt; off, its first words name it. */
    autoTitle: boolean;
    /** The model for text runs (chat titles, other short labels): a Claude alias or id; empty: Claude's default. */
    textGenerationModel: string;
};

export type Settings = {
    version: number;
    appearance: AppearanceSettings;
    updates: UpdatesSettings;
    keyboard: KeyboardSettings;
    claude: ClaudeSettings;
    chat: ChatSettings;
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
    },
    chat: {
        defaultModel: "claude-opus-5-5",
        defaultEffort: "high",
        defaultFastMode: false,
        idleTimeoutMinutes: 15,
        autoTitle: true,
        textGenerationModel: "haiku"
    }
};
