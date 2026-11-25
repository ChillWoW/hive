import { Select } from "@/ui";
import { allThemes, useThemesStore } from "./store";
import type { Theme } from "./themes";

/** A dropdown of every theme, built-in and user, each with a colour swatch. */
export function ThemePicker({
    value,
    onChange
}: {
    value: string;
    onChange: (name: string) => void;
}) {
    const user = useThemesStore((s) => s.user);
    const themes = allThemes(user);

    const label = (name: string) => (
        <>
            {themes[name] && <Swatch theme={themes[name]} />}
            <span className="truncate">
                {name}
                {name in user && <span className="text-muted"> · custom</span>}
            </span>
        </>
    );

    return (
        <Select
            value={value}
            onValueChange={(next) => {
                if (next !== null) onChange(next);
            }}
        >
            <Select.Trigger aria-label="Theme">
                <Select.Value className="flex items-center gap-2">
                    {(name: string) => label(name)}
                </Select.Value>
            </Select.Trigger>
            <Select.Content>
                {Object.keys(themes).map((name) => (
                    <Select.Item key={name} value={name}>
                        {label(name)}
                    </Select.Item>
                ))}
            </Select.Content>
        </Select>
    );
}

/** Background, surface and accent side by side, in the theme's own colours. */
function Swatch({ theme: t }: { theme: Theme }) {
    return (
        <span
            aria-hidden
            className="flex h-3.5 w-6 shrink-0 overflow-hidden rounded-[3px] border"
            style={{ borderColor: t.border }}
        >
            <i className="block flex-1" style={{ background: t.bg }} />
            <i className="block flex-1" style={{ background: t.surface }} />
            <i className="block flex-1" style={{ background: t.accent }} />
        </span>
    );
}
