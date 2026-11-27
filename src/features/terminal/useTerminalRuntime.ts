import { useEffect } from "react";
import { usePanelTabsStore } from "@/features/panel-tabs/store";
import { useSettingsStore } from "@/features/settings/store";
import { findTheme, useThemesStore } from "@/features/theme/store";
import { useShortcut } from "@/keybindings";
import { openTerminal } from "./open";
import { terminalOptions } from "./options";
import { configureTerminals, disposeSession, sessionIds } from "./sessions";

/**
 * Terminal tabs: the new-terminal shortcut, the settings and theme applied
 * to every terminal as they change, and a terminal's shell hung up once its
 * tab closes. Mount once, at the root.
 */
export function useTerminalRuntime() {
    const terminal = useSettingsStore((s) => s.settings.terminal);
    const codeFont = useSettingsStore((s) => s.settings.appearance.codeFontFamily);
    const themeName = useSettingsStore((s) => s.settings.appearance.theme);
    const userThemes = useThemesStore((s) => s.user);

    useShortcut("newTerminal", () => {
        openTerminal();
    });

    useEffect(() => {
        const theme = findTheme(themeName, userThemes);
        configureTerminals(terminalOptions(terminal, codeFont, theme), terminal.gpuAcceleration);
    }, [terminal, codeFont, themeName, userThemes]);

    useEffect(
        () =>
            usePanelTabsStore.subscribe((state) => {
                const open = new Set(state.tabs.map((t) => t.id));
                for (const id of sessionIds()) if (!open.has(id)) disposeSession(id);
            }),
        []
    );
}
