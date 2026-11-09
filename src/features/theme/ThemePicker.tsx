import { cn } from "@/lib/cn";
import { allThemes, useThemesStore } from "./store";

/**
 * One swatch per theme, built-in and user. The swatches draw the theme's own
 * colours, so they're the one place a component sets colours inline.
 */
export function ThemePicker({
    value,
    onChange
}: {
    value: string;
    onChange: (name: string) => void;
}) {
    const user = useThemesStore((s) => s.user);
    const themes = allThemes(user);

    return (
        <div role="radiogroup" aria-label="Theme" className="grid grid-cols-3 gap-2 p-4">
            {Object.entries(themes).map(([name, theme]) => (
                <button
                    key={name}
                    type="button"
                    role="radio"
                    aria-checked={name === value}
                    onClick={() => onChange(name)}
                    className={cn(
                        "flex flex-col gap-1.5 rounded-lg border p-1.5 text-left text-xs transition-colors",
                        name === value
                            ? "border-accent text-text ring-1 ring-accent"
                            : "border-border text-muted hover:border-muted/50 hover:text-text"
                    )}
                >
                    <span
                        className="flex h-10 gap-1 rounded-md p-1.5"
                        style={{ background: theme.bg }}
                    >
                        <i className="flex-1 rounded-sm" style={{ background: theme.surface }} />
                        <i className="w-3 rounded-sm" style={{ background: theme.accent }} />
                    </span>
                    <span className="truncate px-0.5">
                        {name}
                        {name in user && <span className="text-muted"> · custom</span>}
                    </span>
                </button>
            ))}
        </div>
    );
}
