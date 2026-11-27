import "@xterm/xterm/css/xterm.css";
import { useEffect, useMemo, useRef } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { Terminal } from "@xterm/xterm";
import { TerminalIcon } from "@phosphor-icons/react";
import { chatsApi } from "@/features/chats/api";
import { taskStartedAt, useChatsStore } from "@/features/chats/store";
import { panelTabs } from "@/features/panel-tabs/store";
import { useSettingsStore } from "@/features/settings/store";
import { findTheme, useThemesStore } from "@/features/theme/store";
import { isAppShortcut, isShortcutOf } from "@/keybindings";
import { useLayoutStore } from "@/layout/store";
import { copyText } from "@/lib/clipboard";
import { errorMessage } from "@/lib/errors";
import { isMac } from "@/lib/platform";
import { formatElapsed, useNow } from "@/lib/time";
import { Button, DotMatrixSpinner, toast } from "@/ui";
import { watchTaskOutput } from "./api";
import { terminalOptions } from "./options";

/**
 * Tab `id`: a background shell's output, live. The agent's CLI writes it to
 * a file, which is followed here into a terminal that only shows it (nothing
 * can be typed: the shell is the agent's). The bar on top says what runs and
 * for how long, with Stop; once the task has ended the output stays.
 */
export function TaskOutputView({
    id,
    chatId,
    taskId,
    path,
    command
}: {
    id: string;
    chatId: string;
    taskId: string;
    path: string;
    command?: string;
}) {
    const host = useRef<HTMLDivElement>(null);
    const shown = useRef<{ term: Terminal; fit: FitAddon } | null>(null);
    const running = useChatsStore((s) => !!s.sessions[chatId]?.tasks.some((t) => t.id === taskId));

    const settings = useSettingsStore((s) => s.settings.terminal);
    const codeFont = useSettingsStore((s) => s.settings.appearance.codeFontFamily);
    const themeName = useSettingsStore((s) => s.settings.appearance.theme);
    const userThemes = useThemesStore((s) => s.user);
    const options = useMemo(
        () => terminalOptions(settings, codeFont, findTheme(themeName, userThemes)),
        [settings, codeFont, themeName, userThemes]
    );

    useEffect(() => {
        const el = host.current;
        if (!el) return;
        const term = new Terminal({
            allowProposedApi: true,
            // The file has bare line feeds.
            convertEol: true,
            disableStdin: true,
            fontWeightBold: "bold"
        });
        const fit = new FitAddon();
        term.loadAddon(fit);
        term.loadAddon(new Unicode11Addon());
        term.unicode.activeVersion = "11";
        term.attachCustomKeyEventHandler((event) => {
            if (event.type !== "keydown") return true;
            if (isShortcutOf(event, "closeTab")) {
                event.preventDefault();
                panelTabs.close(id);
                return false;
            }
            if (isAppShortcut(event)) return false;
            if (!isMac && event.ctrlKey && event.code === "KeyC" && term.hasSelection()) {
                event.preventDefault();
                void copyText(term.getSelection());
                term.clearSelection();
                return false;
            }
            return true;
        });
        term.open(el);
        // Nothing is typed here: no cursor.
        term.write("\x1b[?25l");
        shown.current = { term, fit };

        const fitNow = () => {
            if (el.clientWidth > 0 && el.clientHeight > 0) fit.fit();
        };
        fitNow();
        let frame = 0;
        const observer = new ResizeObserver(() => {
            // Not while the tabs panel slides to or from maximized.
            if (frame || useLayoutStore.getState().sliding) return;
            frame = requestAnimationFrame(() => {
                frame = 0;
                fitNow();
            });
        });
        observer.observe(el);
        const unsubscribe = useLayoutStore.subscribe((state, prev) => {
            if (!state.sliding && prev.sliding) fitNow();
        });
        const unwatch = watchTaskOutput(path, (bytes) => term.write(bytes));
        term.focus();

        return () => {
            unwatch();
            unsubscribe();
            observer.disconnect();
            cancelAnimationFrame(frame);
            shown.current = null;
            term.dispose();
        };
    }, [id, path]);

    // After the terminal is made: the settings and theme, then as they change.
    useEffect(() => {
        const current = shown.current;
        if (!current) return;
        current.term.options = { ...options, cursorBlink: false };
        current.fit.fit();
    }, [options, id, path]);

    return (
        <div className="flex min-h-0 flex-1 flex-col bg-bg">
            <Bar chatId={chatId} taskId={taskId} command={command} running={running} />
            {/* Padding here, not on the terminal's own element, so fitting counts it. */}
            <div className="flex min-h-0 flex-1 overflow-hidden py-1.5 pl-3">
                <div ref={host} className="h-full min-w-0 flex-1" />
            </div>
        </div>
    );
}

/** Over the output: what runs, how it stands, and Stop while it runs. */
function Bar({
    chatId,
    taskId,
    command,
    running
}: {
    chatId: string;
    taskId: string;
    command?: string;
    running: boolean;
}) {
    const now = useNow(1000, running);
    const started = taskStartedAt(taskId);
    const stop = () =>
        void chatsApi
            .stopTask(chatId, taskId)
            .catch((error) => toast.error({ title: "Couldn't stop it", description: errorMessage(error) }));

    return (
        <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border pr-1.5 pl-3 text-[11px] text-muted">
            {running ? (
                <span className="grid size-3.5 shrink-0 place-items-center text-info">
                    <DotMatrixSpinner interval={400} label="Running" className="size-2.5" />
                </span>
            ) : (
                <TerminalIcon className="size-3.5 shrink-0" />
            )}
            <span className="min-w-0 flex-1 truncate font-mono text-text/85" title={command}>
                {command ?? "Background shell"}
            </span>
            <span role="status" className="shrink-0 tabular-nums">
                {running ? (started !== undefined ? formatElapsed(now - started) : "Running") : "Ended"}
            </span>
            {running && (
                <Button size="xs" variant="ghost" onClick={stop} className="h-6 shrink-0 gap-1.5 px-2 hover:bg-danger/10 hover:text-danger">
                    <span className="size-2 rounded-[2px] bg-current" />
                    Stop
                </Button>
            )}
        </div>
    );
}
