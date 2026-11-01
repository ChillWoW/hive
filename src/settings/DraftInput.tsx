import { useEffect, useState, type ComponentProps } from "react";
import { Input } from "@/ui";

/**
 * A text setting that's saved when the field loses focus or on Enter, not
 * per keystroke; Escape puts the saved value back.
 */
export function DraftInput({
    value,
    onCommit,
    ...props
}: { value: string; onCommit: (value: string) => void } & Omit<
    ComponentProps<typeof Input>,
    "value" | "onChange"
>) {
    const [draft, setDraft] = useState(value);
    useEffect(() => setDraft(value), [value]);

    const commit = () => {
        const next = draft.trim();
        if (next !== value) onCommit(next);
        else setDraft(value);
    };

    return (
        <Input
            size="sm"
            spellCheck={false}
            autoComplete="off"
            {...props}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
                if (event.key === "Enter") {
                    event.preventDefault();
                    commit();
                } else if (event.key === "Escape" && draft !== value) {
                    // Keeps the settings modal open.
                    event.preventDefault();
                    event.stopPropagation();
                    setDraft(value);
                }
            }}
        />
    );
}
