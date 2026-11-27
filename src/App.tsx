import type { ComponentType } from "react";
import { ChatHeader, ChatView, useChatRuntime } from "@/features/chat";
import { useChatsRuntime } from "@/features/chats";
import { SettingsModal, useSettingsRuntime } from "@/features/settings";
import { useSidebarRuntime } from "@/features/sidebar";
import { useTerminalRuntime } from "@/features/terminal";
import { useFontRuntime } from "@/features/fonts/useFontRuntime";
import { useThemeRuntime } from "@/features/theme/useThemeRuntime";
import { useUpdaterRuntime } from "@/features/updater";
import { useKeybindingsRuntime } from "@/keybindings";
import {
    BOX_INSET,
    Dock,
    FilePanel,
    RightSidebar,
    Sidebar,
    TopBar,
    usePlacement,
    type Panel
} from "@/layout";
import { Toaster } from "@/ui";

const PANELS: Record<Panel, ComponentType> = {
    chats: Sidebar,
    tabs: RightSidebar,
    files: FilePanel
};

export function App() {
    useSettingsRuntime();
    useThemeRuntime();
    useFontRuntime();
    useKeybindingsRuntime();
    useUpdaterRuntime();
    useChatsRuntime();
    useChatRuntime();
    useSidebarRuntime();
    useTerminalRuntime();
    const placement = usePlacement();
    const dockLeft = placement.dock === "left";

    return (
        // The frame (top bar and dock, one strip around two sides) holds the
        // panels and main column in an inset box. `appearance.layout` says
        // which side the dock is on and where each panel sits.
        <div className="flex h-screen flex-col bg-surface text-text">
            <TopBar />
            <div className={dockLeft ? "flex min-h-0 flex-1" : "flex min-h-0 flex-1 flex-row-reverse"}>
                <Dock />
                <div
                    style={{
                        [dockLeft ? "marginRight" : "marginLeft"]: BOX_INSET,
                        marginBottom: BOX_INSET
                    }}
                    className="flex min-w-0 flex-1 overflow-hidden rounded-lg border border-border bg-bg"
                >
                    {/* One keyed list, so a panel moved across the main column keeps its state. */}
                    {placement.columns.map((column) => {
                        if (column === "dock") return null;
                        if (column === "main") {
                            return (
                                <main key="main" className="flex min-w-0 flex-1 flex-col overflow-hidden">
                                    <ChatHeader />
                                    <div className="min-h-0 flex-1">
                                        <ChatView />
                                    </div>
                                </main>
                            );
                        }
                        const PanelView = PANELS[column];
                        return <PanelView key={column} />;
                    })}
                </div>
            </div>
            <SettingsModal />
            <Toaster />
        </div>
    );
}
