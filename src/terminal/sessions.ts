import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import { openUrl } from "@tauri-apps/plugin-opener";
import { isAppShortcut } from "@/keybindings";
import { isMac, isTauri } from "@/lib/platform";
import { foregroundProcess, killTerminal, resizeTerminal, spawnTerminal, writeTerminal } from "./api";
import { TERMINAL_OPTIONS } from "./theme";

export type SessionEvents = {
    /**
     * What the tab is called, whenever that changes: the title the running
     * program set (Claude Code's task, vim's file), else the program's name
     * (`cargo`, `node`), else the shell's (`pwsh`, `zsh`).
     */
    onTitle?: (title: string) => void;
    /** The shell quit with code 0 (`exit`); other endings stay on screen. */
    onClosed?: () => void;
};

type Session = {
    cwd: string | null;
    term: Terminal;
    fit: FitAddon;
    /** Holds the terminal; moved into the tab's view while it's shown. */
    host: HTMLDivElement;
    opened: boolean;
    /** The running shell, once started. */
    pty: number | null;
    /** Typed before the shell was up. */
    pending: Uint8Array[];
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
};

function updateTitle(session: Session) {
    const { program, process, shell } = session;
    const title =
        program && process === program.process ? program.title : (process ?? shell);
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
 * so a prompt's title or the console's own (an `.exe` path on Windows) never
 * names the tab.
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

/** Live outside React, so a tab's scrollback and shell survive it being off screen. */
const sessions = new Map<string, Session>();
const encoder = new TextEncoder();

function send(session: Session, bytes: Uint8Array) {
    if (session.pty == null) session.pending.push(bytes);
    else writeTerminal(session.pty, bytes);
}

/** Copy and paste as in Windows Terminal: Ctrl+C copies a selection, Ctrl+V pastes. */
function onKey(term: Terminal, event: KeyboardEvent) {
    if (event.type !== "keydown") return true;
    // The app's shortcuts (new chat, back, …) still work in here.
    if (isAppShortcut(event)) return false;
    if (isMac || !event.ctrlKey || event.altKey || event.metaKey) return true;
    if (event.code === "KeyC" && (event.shiftKey || term.hasSelection())) {
        event.preventDefault();
        const text = term.getSelection();
        if (text) void navigator.clipboard.writeText(text);
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
    const term = new Terminal(TERMINAL_OPTIONS);
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(
        new WebLinksAddon((_event, uri) => {
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
        host,
        opened: false,
        pty: null,
        pending: [],
        events,
        shell: null,
        process: null,
        program: null,
        title: null,
        titleSeq: 0
    };
    sessions.set(id, session);
    term.onTitleChange((title) => onTitleChange(id, session, title));

    term.attachCustomKeyEventHandler((event) => onKey(term, event));
    term.onData((data) => send(session, encoder.encode(data)));
    // Some mouse reports: one byte per character.
    term.onBinary((data) => send(session, Uint8Array.from(data, (c) => c.charCodeAt(0))));
    term.onResize(({ cols, rows }) => {
        if (session.pty != null) resizeTerminal(session.pty, cols, rows);
    });
}

async function start(id: string, session: Session) {
    try {
        const { id: pty, shell } = await spawnTerminal(
            session.cwd,
            session.term.cols,
            session.term.rows,
            (bytes) => session.term.write(bytes),
            (code) => {
                if (sessions.get(id) !== session || session.pty !== pty) return;
                session.pty = null;
                if (code === 0) {
                    session.events.onClosed?.();
                    return;
                }
                const how = code == null ? "ended" : `exited with code ${code}`;
                session.term.write(`\r\n\x1b[2m[Process ${how}]\x1b[0m\r\n`);
            },
            (name) => {
                if (sessions.get(id) === session) onProcess(session, name);
            }
        );
        if (sessions.get(id) !== session) {
            killTerminal(pty);
            return;
        }
        session.pty = pty;
        for (const bytes of session.pending.splice(0)) writeTerminal(pty, bytes);
        // The view may have been resized while the shell started.
        if (session.term.cols !== 0) resizeTerminal(pty, session.term.cols, session.term.rows);
        session.shell = shell;
        updateTitle(session);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        session.term.write(`\x1b[2m${message}\x1b[0m\r\n`);
    }
}

function fitSession(session: Session) {
    const parent = session.host.parentElement;
    if (!parent || parent.clientWidth === 0 || parent.clientHeight === 0) return;
    session.fit.fit();
}

/** Shows tab `id`'s terminal in `parent` (starting its shell the first time) and focuses it. */
export function attachSession(id: string, parent: HTMLElement) {
    const session = sessions.get(id);
    if (!session) return () => {};
    parent.appendChild(session.host);

    if (!session.opened) {
        session.opened = true;
        session.term.open(session.host);
        try {
            const webgl = new WebglAddon();
            webgl.onContextLoss(() => webgl.dispose());
            session.term.loadAddon(webgl);
        } catch {
            // The DOM renderer it is.
        }
        fitSession(session);
        void start(id, session);
    } else {
        fitSession(session);
        session.term.refresh(0, session.term.rows - 1);
    }
    session.term.focus();

    const observer = new ResizeObserver(() => fitSession(session));
    observer.observe(parent);
    return () => {
        observer.disconnect();
        if (session.host.parentElement === parent) session.host.remove();
    };
}

/** Kills tab `id`'s shell and drops its terminal. */
export function disposeSession(id: string) {
    const session = sessions.get(id);
    if (!session) return;
    sessions.delete(id);
    if (session.pty != null) killTerminal(session.pty);
    session.term.dispose();
    session.host.remove();
}
