import { useEffect } from "react";
import { Select } from "@/ui";
import { cssFontFamily, fontChoices, useFontsStore } from "./store";

/** The bundled font and every installed family, each shown in its own face. */
export function FontPicker({
    value,
    onChange
}: {
    value: string;
    onChange: (name: string) => void;
}) {
    const installed = useFontsStore((s) => s.installed);
    const load = useFontsStore((s) => s.load);

    useEffect(() => {
        void load();
    }, [load]);

    const options = fontChoices(installed ?? [], value).map((name) => ({
        value: name,
        labelStyle: { fontFamily: `${cssFontFamily(name)}, var(--font-sans)` }
    }));

    return (
        <Select
            aria-label="Interface font"
            value={value}
            onValueChange={onChange}
            options={options}
            searchable
            searchPlaceholder="Search fonts…"
            emptyText={installed === null ? "Loading fonts…" : "No fonts found"}
        />
    );
}
