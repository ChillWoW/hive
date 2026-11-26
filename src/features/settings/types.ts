/**
 * Mirror of `src-tauri/src/settings/schema.rs`; change both together.
 */

import type { AccessMode, ReasoningLevel } from "@/proto";

export type AppearanceSettings = {
    /** A theme's name; see `src/features/theme/themes.ts`. */
    theme: string;
    /** A font family: the bundled default or an installed one; see `src/features/fonts/`. */
    fontFamily: string;
    /** The window's columns, left to right; each once, the dock at an end. See `src/layout/placement.ts`. */
    layout: LayoutColumn[];
};

/** A column of the window: the dock, a side panel (chats, tabs, files), or the main chat column. */
export type LayoutColumn = "dock" | "chats" | "main" | "tabs" | "files";

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
    /** What a new chat's agent may do without asking. */
    defaultAccess: AccessMode;
    /** The context size (tokens) Claude compacts at; 0 keeps its default. Applies to new runs. */
    autoCompactWindow: number;
    /** Extra arguments for every chat's `claude`, split like a shell would. */
    launchArgs: string;
    /** Extra environment variables for every `claude`, as `KEY=value` lines. */
    env: string;
    /** Claude's settings and login folder (`CLAUDE_CONFIG_DIR`); empty: `~/.claude`. */
    configDir: string;
    /** The plan's usage as a ring in the dock; see `src/layout/DockUsage.tsx`. */
    showUsageInDock: boolean;
};

export type BusySend = "queue" | "after-tool" | "interrupt";

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
    /** Thinking blocks start expanded in the transcript. */
    reasoningExpanded: boolean;
    /** Tool rows start expanded, showing their output. */
    toolOutputExpanded: boolean;
    /** What sending does while a turn runs: queue it, stop the turn after its running tool call and send, or stop it and send now. */
    busySend: BusySend;
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
        fontFamily: "Geist",
        layout: ["dock", "chats", "main", "tabs", "files"]
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
        binaryPath: "",
        defaultAccess: "full-access",
        autoCompactWindow: 0,
        launchArgs: "",
        env: "",
        configDir: "",
        showUsageInDock: false
    },
    chat: {
        defaultModel: "claude-opus-5-5",
        defaultEffort: "high",
        defaultFastMode: false,
        idleTimeoutMinutes: 15,
        autoTitle: true,
        textGenerationModel: "haiku",
        reasoningExpanded: false,
        toolOutputExpanded: false,
        busySend: "queue"
    }
};
