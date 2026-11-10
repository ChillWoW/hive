import { CheckIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/cn";
import { allThemes, useThemesStore } from "./store";
import type { Theme } from "./themes";

/**
 * One card per theme, built-in and user: a miniature of the app drawn in the
 * theme's own colours, so it's the one place a component sets colours inline.
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
        <div role="radiogroup" aria-label="Theme" className="grid grid-cols-3 gap-3 p-4">
            {Object.entries(themes).map(([name, theme]) => {
                const selected = name === value;
                return (
                    <button
                        key={name}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        onClick={() => onChange(name)}
                        className={cn(
                            "group flex flex-col gap-2 rounded-lg p-1 text-left text-xs outline-none",
                            "focus-visible:ring-2 focus-visible:ring-accent/60"
                        )}
                    >
                        <span
                            className={cn(
                                "block overflow-hidden rounded-md border transition-[border-color,box-shadow] duration-150",
                                selected
                                    ? "border-accent ring-1 ring-accent"
                                    : "border-border group-hover:border-muted/60"
                            )}
                        >
                            <Preview theme={theme} />
                        </span>
                        <span className="flex items-center gap-1.5 px-0.5">
                            <span
                                className={cn(
                                    "min-w-0 flex-1 truncate transition-colors",
                                    selected ? "text-text" : "text-muted group-hover:text-text"
                                )}
                            >
                                {name}
                                {name in user && <span className="text-muted"> · custom</span>}
                            </span>
                            {selected && <CheckIcon weight="bold" className="size-3 shrink-0 text-accent" />}
                        </span>
                    </button>
                );
            })}
        </div>
    );
}

/** A tiny sidebar + transcript + composer, in the theme's colours. */
function Preview({ theme: t }: { theme: Theme }) {
    const line = (width: string, color: string, opacity = 1) => (
        <i className="block h-[3px] rounded-full" style={{ width, background: color, opacity }} />
    );

    return (
        <span className="flex aspect-[16/10] w-full" style={{ background: t.bg }}>
            <span
                className="flex w-[28%] flex-col gap-1.5 p-1.5"
                style={{ background: t.surface, borderRight: `1px solid ${t.border}` }}
            >
                <i className="block h-2 rounded-sm" style={{ background: t.hover }} />
                {line("80%", t.muted, 0.7)}
                {line("60%", t.muted, 0.7)}
                {line("70%", t.muted, 0.7)}
            </span>
            <span className="flex flex-1 flex-col gap-1.5 p-2">
                {line("70%", t.text)}
                {line("90%", t.muted)}
                {line("55%", t.muted)}
                <span className="flex gap-1">
                    <i className="block size-1 rounded-full" style={{ background: t.success }} />
                    <i className="block size-1 rounded-full" style={{ background: t.warning }} />
                    <i className="block size-1 rounded-full" style={{ background: t.danger }} />
                </span>
                <span
                    className="mt-auto flex h-3.5 items-center justify-end rounded-sm px-0.5"
                    style={{ background: t.raised, border: `1px solid ${t.border}` }}
                >
                    <i className="block h-2 w-3 rounded-[2px]" style={{ background: t.accent }} />
                </span>
            </span>
        </span>
    );
}
