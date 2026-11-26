import type { ReactNode } from "react";
import { ChatsCircleIcon, GearSixIcon } from "@phosphor-icons/react";
import { useSettingsStore } from "@/features/settings";
import type { ShortcutRef } from "@/keybindings/runtime";
import { cn } from "@/lib/cn";
import { IconButton } from "@/ui";
import { DOCK_WIDTH, useLayoutStore, usePanelShown } from "./store";

/**
 * The strip at the window's left edge, before the sidebar: views at its top
 * (chats, for now), settings at its foot. With the top bar it frames the inset box.
 */
export function Dock() {
    const sidebarShown = usePanelShown("left");
    const toggle = useLayoutStore((s) => s.toggle);
    const settingsOpen = useSettingsStore((s) => s.isOpen);
    const toggleSettings = useSettingsStore((s) => s.toggle);

    return (
        <nav
            aria-label="Dock"
            style={{ width: DOCK_WIDTH }}
            className="flex h-full shrink-0 flex-col items-center gap-1 pt-2 pb-2"
        >
            <DockButton
                label="Chats"
                shortcut="toggleSidebar"
                active={sidebarShown}
                onClick={() => toggle("left")}
            >
                <ChatsCircleIcon weight={sidebarShown ? "fill" : "regular"} className="size-5" />
            </DockButton>
            <div className="flex-1" />
            <DockButton
                label="Settings"
                shortcut="openSettings"
                active={settingsOpen}
                onClick={toggleSettings}
            >
                <GearSixIcon weight={settingsOpen ? "fill" : "regular"} className="size-5" />
            </DockButton>
        </nav>
    );
}

/** A dock entry: a larger icon button, its tooltip to the right. */
function DockButton({
    active,
    children,
    ...props
}: {
    label: string;
    shortcut?: ShortcutRef;
    active?: boolean;
    onClick?: () => void;
    children: ReactNode;
}) {
    return (
        <IconButton
            side="right"
            aria-pressed={active}
            className={cn("size-8", active && "text-text")}
            {...props}
        >
            {children}
        </IconButton>
    );
}
