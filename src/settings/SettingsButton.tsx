import { GearSixIcon } from "@phosphor-icons/react";
import { useBinding } from "@/keybindings/runtime";
import { ShortcutKeys } from "@/keybindings/ShortcutKeys";
import { cn } from "@/lib/cn";
import { useSettingsStore } from "./store";

/** The sidebar's footer entry; its shortcut (Mod+, by default) does the same from anywhere. */
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
                    ? "bg-dark-700 text-dark-50"
                    : "text-dark-200 hover:bg-dark-800 hover:text-dark-50 active:bg-dark-700",
                className
            )}
        >
            <GearSixIcon
                className="size-4 shrink-0 transition-transform duration-300 group-hover:rotate-45"
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
