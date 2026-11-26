import type { ReactNode } from "react";
import { ChatsCircleIcon, GearSixIcon } from "@phosphor-icons/react";
import { useSettingsStore } from "@/features/settings";
import type { ShortcutRef } from "@/keybindings/runtime";
import { cn } from "@/lib/cn";
import { IconButton } from "@/ui";
import { DockUsage } from "./DockUsage";
import { usePlacement } from "./placement";
import { DOCK_WIDTH, useLayoutStore, usePanelShown } from "./store";

/**
 * The strip at one window edge (the left by default; see `placement.ts`):
 * views at its top (chats, for now); at its foot the plan's usage (when
 * shown) and settings. With the top bar
 * it frames the inset box.
 */
export function Dock() {
    const chatsShown = usePanelShown("chats");
    const toggle = useLayoutStore((s) => s.toggle);
    const settingsOpen = useSettingsStore((s) => s.isOpen);
    const toggleSettings = useSettingsStore((s) => s.toggle);
    // Tooltips open toward the window's middle.
    const side = usePlacement().dock === "left" ? "right" : "left";

    return (
        <nav
            aria-label="Dock"
            style={{ width: DOCK_WIDTH }}
            className="flex h-full shrink-0 flex-col items-center gap-1 pt-2 pb-2"
        >
            <DockButton
                label="Chats"
                shortcut="toggleSidebar"
                side={side}
                active={chatsShown}
                onClick={() => toggle("chats")}
            >
                <ChatsCircleIcon weight={chatsShown ? "fill" : "regular"} className="size-5" />
            </DockButton>
            <div className="flex-1" />
            <DockUsage side={side} />
            <DockButton
                label="Settings"
                shortcut="openSettings"
                side={side}
                active={settingsOpen}
                onClick={toggleSettings}
            >
                <GearSixIcon weight={settingsOpen ? "fill" : "regular"} className="size-5" />
            </DockButton>
        </nav>
    );
}

/** A dock entry: a larger icon button. */
function DockButton({
    active,
    children,
    ...props
}: {
    label: string;
    shortcut?: ShortcutRef;
    side: "left" | "right";
    active?: boolean;
    onClick?: () => void;
    children: ReactNode;
}) {
    return (
        <IconButton aria-pressed={active} className={cn("size-8", active && "text-text")} {...props}>
            {children}
        </IconButton>
    );
}
