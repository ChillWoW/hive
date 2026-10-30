import { cn } from "@/lib/cn";
import { isMac } from "@/lib/platform";
import { parseShortcut, shortcutKeys, type Shortcut } from "./shortcut";

/**
 * A shortcut as the platform writes it; nothing when unbound. `caps` draws
 * each key on its own cap (the settings page); `plain` is muted text,
 * `Ctrl+N` or `⌘N`, for tooltips and hints beside a label.
 */
export function ShortcutKeys({
    shortcut,
    variant = "caps",
    className
}: {
    /** Stored text (`Mod+N`) or a parsed shortcut. */
    shortcut: string | Shortcut;
    variant?: "caps" | "plain";
    className?: string;
}) {
    const parsed =
        typeof shortcut === "string"
            ? shortcut.trim()
                ? parseShortcut(shortcut)
                : null
            : shortcut;
    if (!parsed) return null;
    const keys = shortcutKeys(parsed);

    if (variant === "plain") {
        return (
            <kbd
                className={cn(
                    "[font-family:inherit] text-[11px] font-medium tracking-wide text-dark-250",
                    className
                )}
            >
                {keys.join(isMac ? "" : "+")}
            </kbd>
        );
    }

    return (
        <span className={cn("inline-flex items-center gap-1", className)}>
            {keys.map((key, index) => (
                <kbd
                    key={index}
                    className="inline-flex h-5 min-w-5 items-center justify-center rounded border border-dark-500 bg-dark-700 px-1.5 font-sans text-[11px] leading-none text-dark-100"
                >
                    {key}
                </kbd>
            ))}
        </span>
    );
}
