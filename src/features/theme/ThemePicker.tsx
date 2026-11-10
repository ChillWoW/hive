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
    const options = Object.entries(allThemes(user)).map(([name, theme]) => ({
        value: name,
        icon: <Swatch theme={theme} />,
        label:
            name in user ? (
                <>
                    {name}
                    <span className="text-muted"> · custom</span>
                </>
            ) : (
                name
            )
    }));

    return <Select aria-label="Theme" value={value} onValueChange={onChange} options={options} />;
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
