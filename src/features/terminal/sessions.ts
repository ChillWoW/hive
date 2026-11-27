import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal, type ITerminalOptions } from "@xterm/xterm";
import { openUrl } from "@tauri-apps/plugin-opener";
import { settings } from "@/features/settings/store";
import { isAppShortcut, isShortcutOf } from "@/keybindings";
import { useLayoutStore } from "@/layout/store";
import { copyText } from "@/lib/clipboard";
import { errorMessage } from "@/lib/errors";
import { isMac, isTauri } from "@/lib/platform";
import { foregroundProcess, killTerminal, resizeTerminal, spawnTerminal, writeTerminal } from "./api";

export type SessionEvents = {
    /**
     * What the tab is called, whenever that changes: the title the running
     * program set (Claude Code's task, vim's file), else the program's name
     * (`cargo`, `node`), else the shell's (`zsh`, `pwsh`).
     */
    onTitle?: (title: string) => void;
    /**
     * The tab should close: its shell exited and `terminal.closeOnExit` says
     * the tab goes with it, or the close-tab shortcut was pressed in it.
     */
    onClose?: () => void;
};

type Session = {
    cwd: string | null;
    term: Terminal;
    fit: FitAddon;
    webgl: WebglAddon | null;
    /** Holds the terminal; moved into the tab's view while it's shown. */
    host: HTMLDivElement;
    opened: boolean;
    /** Bumped per shell started in it, so a gone shell's late events are dropped. */
    run: number;
    /** The running shell, once started. */
    pty: number | null;
    /** The shell has gone and the tab stayed: Enter starts a new one. */
    exited: boolean;
    /** Typed but not yet sent: sent in order, one write in flight at a time. */
    input: Uint8Array[];
    writing: boolean;
    events: SessionEvents;
    /** The shell's name, once started. */
    shell: string | null;
    /** The program in front, or null while the shell is. */
    process: string | null;
    /** The title `process` set, if it did. */
    program: { process: string; title: string } | null;
    /** The last title sent to `onTitle`. */
    title: string | null;
    /** Bumped per title the terminal sets, so a stale lookup is dropped. */
    titleSeq: number;
    /** A pending fit's animation frame. */
    frame: number;
    copyTimer: ReturnType<typeof setTimeout> | undefined;
};

/** Live outside React, so a tab's scrollback and shell survive it being off screen. */
const sessions = new Map<string, Session>();
const encoder = new TextEncoder();

/** What every terminal is drawn with; `configureTerminals` keeps it to the settings. */
let options: ITerminalOptions = {};
let gpu = true;

const BASE_OPTIONS: ITerminalOptions = {
    allowProposedApi: true,
    // Option-click selects even while a program (vim, tmux) has the mouse.
    macOptionClickForcesSelection: true,
    fontWeightBold: "bold"
};

const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

/**
 * Applies `next` (and WebGL on or off) to every terminal, open or not;
 * terminals made later start with them.
 */
export function configureTerminals(next: ITerminalOptions, useGpu: boolean) {
    const changed = Object.fromEntries(
        Object.entries(next).filter(([key, value]) => !same(options[key as keyof ITerminalOptions], value))
    ) as ITerminalOptions;
    options = next;
    const gpuChanged = useGpu !== gpu;
    gpu = useGpu;
    if (Object.keys(changed).length === 0 && !gpuChanged) return;
    for (const session of sessions.values()) {
        session.term.options = changed;
        if (gpuChanged && session.opened) setWebgl(session, useGpu);
        // A new font or line height changes how many cells fit.
        fitSoon(session);
    }
}

function setWebgl(session: Session, on: boolean) {
    if (!on) {
        session.webgl?.dispose();
        session.webgl = null;
        return;
    }
    if (session.webgl) return;
    try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => {
            webgl.dispose();
            if (session.webgl === webgl) session.webgl = null;
        });
        session.term.loadAddon(webgl);
        session.webgl = webgl;
    } catch {
        // No WebGL here: the DOM renderer it is.
    }
}

function updateTitle(session: Session) {
    const { program, process, shell } = session;
    const title = program && process === program.process ? program.title : (process ?? shell);
    if (!title || title === session.title) return;
    session.title = title;
    session.events.onTitle?.(title);
}

function onProcess(session: Session, name: string | null) {
    session.process = name;
    // A title belongs to the program that set it.
    if (session.program?.process !== name) session.program = null;
    updateTitle(session);
}

/**
 * A title a program set (OSC 0/2). Kept only while that program is in front,
 * so a prompt's title (`user@host: ~/dir`) never names the tab.
 */
function onTitleChange(id: string, session: Session, raw: string) {
    const title = raw.trim();
    if (!title || /\.exe$/i.test(title)) return;
    const seq = ++session.titleSeq;
    const { program, process } = session;
    if (process != null && program?.process === process) {
        session.program = { process, title };
        updateTitle(session);
        return;
    }
    // A program that just started may not have been seen yet: ask now.
    if (session.pty == null) return;
    foregroundProcess(session.pty)
        .then((name) => {
            if (sessions.get(id) !== session || seq !== session.titleSeq) return;
            session.process = name;
            session.program = name == null ? null : { process: name, title };
            updateTitle(session);
        })
        .catch(() => {});
}

function concat(chunks: Uint8Array[]): Uint8Array {
    if (chunks.length === 1) return chunks[0]!;
    const out = new Uint8Array(chunks.reduce((sum, c) => sum + c.length, 0));
    let at = 0;
    for (const chunk of chunks) {
        out.set(chunk, at);
        at += chunk.length;
    }
    return out;
}

/** Sends what's been typed: one write at a time, so keys arrive in order; a paste goes as one. */
function flush(session: Session) {
    const pty = session.pty;
    if (pty == null || session.writing || session.input.length === 0) return;
    session.writing = true;
    const bytes = concat(session.input.splice(0));
    void writeTerminal(pty, bytes)
        .catch(() => {})
        .finally(() => {
            session.writing = false;
            flush(session);
        });
}

function send(id: string, session: Session, bytes: Uint8Array) {
    if (session.exited) {
        // Enter on a finished terminal starts a new shell in it.
        if (bytes.length === 1 && bytes[0] === 13) void start(id, session);
        return;
    }
    session.input.push(bytes);
    flush(session);
}

const typed = (id: string, session: Session, text: string) => send(id, session, encoder.encode(text));

/** macOS text-editing keys, as shells' line editors know them (Terminal.app and iTerm do the same). */
function macEditingKey(event: KeyboardEvent): string | null {
    const { metaKey: cmd, altKey: alt, ctrlKey: ctrl, shiftKey: shift, key } = event;
    if (ctrl || shift || cmd === alt) return null;
    if (cmd) return key === "ArrowLeft" ? "\x01" : key === "ArrowRight" ? "\x05" : key === "Backspace" ? "\x15" : null;
    return key === "ArrowLeft" ? "\x1bb" : key === "ArrowRight" ? "\x1bf" : key === "Backspace" ? "\x1b\x7f" : null;
}

/**
 * Keys the terminal doesn't send on: the app's shortcuts (so they work in
 * here too), the close-tab one closing this terminal; ⌘K clears it on macOS,
 * and Ctrl+Shift+C / Ctrl+V (Ctrl+C with a selection) copy and paste
 * elsewhere, as in Windows Terminal.
 */
function onKey(id: string, session: Session, event: KeyboardEvent): boolean {
    if (event.type !== "keydown") return true;
    const { term } = session;
    if (isShortcutOf(event, "closeTab")) {
        event.preventDefault();
        session.events.onClose?.();
        return false;
    }
    if (isAppShortcut(event)) return false;

    if (isMac) {
        if (event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && event.code === "KeyK") {
            event.preventDefault();
            term.clear();
            return false;
        }
        // Only at the prompt: full-screen programs (vim, tmux) get the keys as they are.
        const editing = term.buffer.active.type === "normal" ? macEditingKey(event) : null;
        if (editing) {
            event.preventDefault();
            typed(id, session, editing);
            return false;
        }
        return true;
    }

    if (!event.ctrlKey || event.altKey || event.metaKey) return true;
    if (event.code === "KeyC" && (event.shiftKey || term.hasSelection())) {
        event.preventDefault();
        const text = term.getSelection();
        if (text) void copyText(text);
        term.clearSelection();
        return false;
    }
    // Left to the browser, whose paste event xterm takes up.
    if (event.code === "KeyV") return false;
    return true;
}

/** Makes tab `id`'s terminal; its shell starts once the tab is first shown. */
export function createSession(id: string, cwd: string | null, events: SessionEvents = {}) {
    if (sessions.has(id)) return;
    const term = new Terminal({ ...BASE_OPTIONS, ...options });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = "11";
    term.loadAddon(
        new WebLinksAddon((event, uri) => {
            // ⌘/Ctrl-click, so a click to place the selection doesn't open it.
            if (!(isMac ? event.metaKey : event.ctrlKey)) return;
            if (isTauri) void openUrl(uri);
            else window.open(uri, "_blank", "noopener");
        })
    );
    const host = document.createElement("div");
    host.className = "h-full w-full";
    const session: Session = {
        cwd,
        term,
        fit,
        webgl: null,
        host,
        opened: false,
        run: 0,
        pty: null,
        exited: false,
        input: [],
        writing: false,
        events,
        shell: null,
        process: null,
        program: null,
        title: null,
        titleSeq: 0,
        frame: 0,
        copyTimer: undefined
    };
    sessions.set(id, session);

    term.onTitleChange((title) => onTitleChange(id, session, title));
    term.attachCustomKeyEventHandler((event) => onKey(id, session, event));
    term.onData((data) => typed(id, session, data));
    // Some mouse reports: one byte per character.
    term.onBinary((data) => send(id, session, Uint8Array.from(data, (c) => c.charCodeAt(0))));
    term.onResize(({ cols, rows }) => {
        if (session.pty != null) resizeTerminal(session.pty, cols, rows);
    });
    term.onSelectionChange(() => {
        clearTimeout(session.copyTimer);
        if (!settings.get().terminal.copyOnSelect || !term.hasSelection()) return;
        // Once the drag settles, not on every cell it crosses.
        session.copyTimer = setTimeout(() => {
            const text = term.getSelection();
            if (text) void copyText(text);
        }, 150);
    });
}

function onExit(session: Session, code: number | null) {
    session.pty = null;
    session.input = [];
    session.exited = true;
    onProcess(session, null);
    const close = settings.get().terminal.closeOnExit;
    if (close === "always" || (close === "clean" && code === 0)) {
        session.events.onClose?.();
        return;
    }
    const how = code == null ? "Process ended" : `Process exited with code ${code}`;
    session.term.write(`\r\n\x1b[2m[${how} · Enter starts a new shell]\x1b[0m\r\n`);
}

async function start(id: string, session: Session) {
    const run = ++session.run;
    session.exited = false;
    const current = () => sessions.get(id) === session && session.run === run;
    let ended = false;
    try {
        const { id: pty, shell } = await spawnTerminal(session.cwd, session.term.cols, session.term.rows, {
            onData: (bytes) => {
                if (current()) session.term.write(bytes);
            },
            onProcess: (name) => {
                if (current()) onProcess(session, name);
            },
            onExit: (code) => {
                ended = true;
                if (current()) onExit(session, code);
            }
        });
        if (!current()) {
            killTerminal(pty);
            return;
        }
        session.shell = shell;
        updateTitle(session);
        // It may have gone before it was even reported started.
        if (ended) return;
        session.pty = pty;
        // The view may have been resized while the shell started.
        resizeTerminal(pty, session.term.cols, session.term.rows);
        flush(session);
    } catch (error) {
        if (!current()) return;
        session.exited = true;
        session.term.write(`\x1b[31m${errorMessage(error)}\x1b[0m\r\n`);
        session.term.write(`\x1b[2m[Enter tries again; the shell is set in Settings › Terminal]\x1b[0m\r\n`);
    }
}

function fitNow(session: Session) {
    const parent = session.host.parentElement;
    if (!session.opened || !parent || parent.clientWidth === 0 || parent.clientHeight === 0) return;
    session.fit.fit();
}

/** Fits on the next frame, once per frame however many resizes come in. */
function fitSoon(session: Session) {
    if (session.frame) return;
    session.frame = requestAnimationFrame(() => {
        session.frame = 0;
        fitNow(session);
    });
}

// The terminals on screen fit once the tabs panel's slide is over.
useLayoutStore.subscribe((state, prev) => {
    if (state.sliding || !prev.sliding) return;
    for (const session of sessions.values()) if (session.host.isConnected) fitSoon(session);
});

/** Shows tab `id`'s terminal in `parent` (starting its shell the first time) and focuses it. */
export function attachSession(id: string, parent: HTMLElement) {
    const session = sessions.get(id);
    if (!session) return () => {};
    parent.appendChild(session.host);

    const first = !session.opened;
    if (first) {
        session.opened = true;
        session.term.open(session.host);
        if (gpu) setWebgl(session, true);
    }
    fitNow(session);
    if (first) void start(id, session);
    else session.term.refresh(0, session.term.rows - 1);
    session.term.focus();

    // Not while the tabs panel slides to or from maximized: once, after.
    const observer = new ResizeObserver(() => {
        if (!useLayoutStore.getState().sliding) fitSoon(session);
    });
    observer.observe(parent);
    return () => {
        observer.disconnect();
        if (session.host.parentElement === parent) session.host.remove();
    };
}

/** Focuses tab `id`'s terminal, if it's on screen. */
export function focusSession(id: string) {
    const session = sessions.get(id);
    if (session?.host.isConnected) session.term.focus();
}

/** The tab ids with a terminal. */
export const sessionIds = () => [...sessions.keys()];

/** Hangs up tab `id`'s shell and drops its terminal. */
export function disposeSession(id: string) {
    const session = sessions.get(id);
    if (!session) return;
    sessions.delete(id);
    cancelAnimationFrame(session.frame);
    clearTimeout(session.copyTimer);
    if (session.pty != null) killTerminal(session.pty);
    session.webgl?.dispose();
    session.term.dispose();
    session.host.remove();
}
