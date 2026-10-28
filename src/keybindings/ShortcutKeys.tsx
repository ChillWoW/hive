import { cn } from "@/lib/cn";
import { parseShortcut, shortcutKeys, type Shortcut } from "./shortcut";

/** A shortcut drawn as key caps; nothing when unbound. */
export function ShortcutKeys({
    shortcut,
    className
}: {
    /** Stored text (`Mod+N`) or a parsed shortcut. */
    shortcut: string | Shortcut;
    className?: string;
}) {
    const parsed =
        typeof shortcut === "string"
            ? shortcut.trim()
                ? parseShortcut(shortcut)
                : null
            : shortcut;
    if (!parsed) return null;

    return (
        <span className={cn("inline-flex items-center gap-1", className)}>
            {shortcutKeys(parsed).map((key, index) => (
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
