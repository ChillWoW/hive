import { GearSixIcon } from "@phosphor-icons/react";
import { useBinding } from "@/keybindings/runtime";
import { ShortcutKeys } from "@/keybindings/ShortcutKeys";
import { cn } from "@/lib/cn";
import { useSettingsStore } from "./store";

/** A sidebar footer entry; its shortcut (Mod+, by default) does the same from anywhere. */
export function SettingsButton({ className }: { className?: string }) {
    const isOpen = useSettingsStore((s) => s.isOpen);
    const toggle = useSettingsStore((s) => s.toggle);
    const binding = useBinding("openSettings");

    return (
        <button
            type="button"
            onClick={toggle}
            aria-pressed={isOpen}
            className={cn(
                "group flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-xs",
                "transition-colors duration-150",
                isOpen
                    ? "bg-hover text-text"
                    : "text-muted hover:bg-raised hover:text-text active:bg-hover",
                className
            )}
        >
            <GearSixIcon
                className="size-4 shrink-0"
                weight={isOpen ? "fill" : "regular"}
            />
            <span className="min-w-0 flex-1 truncate">Settings</span>
            <ShortcutKeys
                shortcut={binding}
                variant="plain"
                className="opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
            />
        </button>
    );
}
