/**
 * Mirror of `src-tauri/src/settings/schema.rs`; change both together.
 */

import type { AccessMode, ReasoningLevel } from "@/proto";

export type AppearanceSettings = {
    /** A theme's name; see `src/features/theme/themes.ts`. */
    theme: string;
    /** A font family: the bundled default, "System" (the platform UI font) or an installed one; see `src/features/fonts/`. */
    fontFamily: string;
    /** The code font (code blocks, diffs): an installed family; empty: the system monospace font. */
    codeFontFamily: string;
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
    maximizeTabsPanel: string;
    goBack: string;
    goForward: string;
    newTab: string;
    closeTab: string;
    nextTab: string;
    previousTab: string;
    goToTab1: string;
    goToTab2: string;
    goToTab3: string;
    goToTab4: string;
    goToTab5: string;
    goToTab6: string;
    goToTab7: string;
    goToTab8: string;
    goToLastTab: string;
    newTerminal: string;
    showChanges: string;
    showHistory: string;
    refresh: string;
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

export type CodexSettings = {
    /** The plan's usage as a ring in the dock; see `src/layout/DockUsage.tsx`. */
    showUsageInDock: boolean;
};

export type AntigravitySettings = {
    /** The account's model quota as a ring in the dock; see `src/layout/DockUsage.tsx`. */
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
    /** After each completed turn the agent guesses the next prompt, shown in the empty composer for Tab to take. */
    promptSuggestions: boolean;
};

/** How a new worktree's branch is named: `<prefix>/<slug>`, or `<type>/<slug>` by the text generation model. */
export type BranchNaming = "static" | "semantic";

export type WorktreesSettings = {
    /** The folder new worktrees go in; empty (or not absolute; `~` is home) uses `<data dir>/worktrees`. */
    location: string;
    branchNaming: BranchNaming;
    /** With static naming, new branches are `<prefix>/<slug>`; empty, just the slug. */
    branchPrefix: string;
    /** Deleting a worktree chat deletes its branch too, merged or not. */
    deleteBranch: boolean;
};

/** How a diff marks changed lines: `+`/`−`, a bar at the edge, or only the tint. */
export type DiffIndicators = "classic" | "bars" | "none";

/** What a diff highlights inside a changed line. */
export type InlineChanges = "word" | "char" | "off";

/** How the changes tab lays out a diff: one column, or old and new side by side. */
export type DiffStyle = "unified" | "split";

export type DiffsSettings = {
    /** Long lines wrap rather than scroll sideways. */
    wrapLines: boolean;
    indicators: DiffIndicators;
    inlineChanges: InlineChanges;
    /** The changes tab's layout; the transcript's diffs are always unified. */
    style: DiffStyle;
};

/** Where a new terminal starts: the open chat's folder (its worktree, if any), or home. */
export type TerminalStartIn = "workspace" | "home";

export type TerminalCursor = "bar" | "block" | "underline";

/** When a terminal's tab closes with its shell: after a clean `exit` (code 0), always, or never. */
export type TerminalCloseOnExit = "clean" | "always" | "never";

/** Terminal tabs, in the code font; see `src/features/terminal/`. The shell ones apply to terminals opened after a change. */
export type TerminalSettings = {
    /** The shell to run; empty: the login shell (`$SHELL`), or PowerShell on Windows. */
    shell: string;
    /** Its arguments, split like a shell would; empty: the usual ones (a login shell on macOS). */
    shellArgs: string;
    /** Extra environment variables, as `KEY=value` lines. */
    env: string;
    startIn: TerminalStartIn;
    /** In px (8–32). */
    fontSize: number;
    /** A multiple of the font size (1–2). */
    lineHeight: number;
    cursorStyle: TerminalCursor;
    cursorBlink: boolean;
    /** Lines kept above the screen (0–100000). */
    scrollback: number;
    /** Selecting text copies it. */
    copyOnSelect: boolean;
    /** Option sends Meta (Alt) rather than typing special characters (macOS). */
    optionAsMeta: boolean;
    closeOnExit: TerminalCloseOnExit;
    /** Draw with WebGL; off, the slower DOM renderer. */
    gpuAcceleration: boolean;
};

/** What plays when a chat wants attention; made by `src/features/notifications/sounds.ts`. */
export type NotificationSound = "none" | "chime" | "ping" | "pop" | "knock" | "buzz";

/** Telling the user about chats they aren't watching; see `src/features/notifications/`. */
export type NotificationsSettings = {
    /** A system notification for each. */
    desktop: boolean;
    /** A turn finished. */
    doneSound: NotificationSound;
    /** A turn waits on the user: an approval, a question, a plan or a secret. */
    inputSound: NotificationSound;
    /** A turn failed. */
    errorSound: NotificationSound;
    /** In percent (0–100). */
    volume: number;
    /** The number of chats waiting, on the taskbar or dock icon, until the window is next focused. */
    badge: boolean;
    /** Stay quiet while the window is focused. */
    onlyInBackground: boolean;
};

export type Settings = {
    version: number;
    appearance: AppearanceSettings;
    updates: UpdatesSettings;
    keyboard: KeyboardSettings;
    claude: ClaudeSettings;
    codex: CodexSettings;
    antigravity: AntigravitySettings;
    chat: ChatSettings;
    worktrees: WorktreesSettings;
    diffs: DiffsSettings;
    terminal: TerminalSettings;
    notifications: NotificationsSettings;
};

export const DEFAULT_SETTINGS: Settings = {
    version: 1,
    appearance: {
        theme: "Outcode Slate",
        fontFamily: "Geist",
        codeFontFamily: "",
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
        toggleFilePanel: "Mod+Shift+E",
        maximizeTabsPanel: "Mod+Shift+M",
        goBack: "Mod+[",
        goForward: "Mod+]",
        newTab: "Mod+T",
        closeTab: "Mod+W",
        nextTab: "Ctrl+Tab",
        previousTab: "Ctrl+Shift+Tab",
        goToTab1: "Mod+1",
        goToTab2: "Mod+2",
        goToTab3: "Mod+3",
        goToTab4: "Mod+4",
        goToTab5: "Mod+5",
        goToTab6: "Mod+6",
        goToTab7: "Mod+7",
        goToTab8: "Mod+8",
        goToLastTab: "Mod+9",
        newTerminal: "Mod+J",
        showChanges: "Mod+Shift+G",
        showHistory: "Mod+Shift+H",
        refresh: "Mod+R"
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
    codex: {
        showUsageInDock: false
    },
    antigravity: {
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
        busySend: "queue",
        promptSuggestions: true
    },
    worktrees: {
        location: "",
        branchNaming: "static",
        branchPrefix: "outcode",
        deleteBranch: false
    },
    diffs: {
        wrapLines: false,
        indicators: "classic",
        inlineChanges: "word",
        style: "unified"
    },
    terminal: {
        shell: "",
        shellArgs: "",
        env: "",
        startIn: "workspace",
        fontSize: 12,
        lineHeight: 1.2,
        cursorStyle: "bar",
        cursorBlink: true,
        scrollback: 5000,
        copyOnSelect: false,
        optionAsMeta: false,
        closeOnExit: "clean",
        gpuAcceleration: true
    },
    notifications: {
        desktop: true,
        doneSound: "chime",
        inputSound: "ping",
        errorSound: "buzz",
        volume: 60,
        badge: true,
        onlyInBackground: true
    }
};
