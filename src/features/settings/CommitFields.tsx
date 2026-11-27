import { useState } from "react";
import { FolderOpenIcon } from "@phosphor-icons/react";
import { Button, Input, Textarea } from "@/ui";

/**
 * A text field saved (trimmed) on blur or Enter; Escape restores the saved
 * value. With `onBrowse`, a browse button at its end.
 */
export function CommitInput({
    value,
    placeholder,
    label,
    onCommit,
    onBrowse,
    browseLabel = "Choose a folder"
}: {
    value: string;
    placeholder?: string;
    /** Its accessible name, when the row's label isn't tied to it. */
    label?: string;
    onCommit: (value: string) => void;
    onBrowse?: () => void;
    browseLabel?: string;
}) {
    const [draft, setDraft] = useState<string | null>(null);
    const commit = () => {
        if (draft !== null && draft.trim() !== value) onCommit(draft.trim());
        setDraft(null);
    };
    const input = (
        <Input
            value={draft ?? value}
            placeholder={placeholder}
            aria-label={label}
            spellCheck={false}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
                if (e.key === "Escape") setDraft(null);
            }}
        />
    );
    if (!onBrowse) return input;
    return (
        <Input.Group>
            {input}
            <Input.Addon>
                <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={browseLabel}
                    onClick={onBrowse}
                    className="size-6 text-muted hover:text-text"
                >
                    <FolderOpenIcon />
                </Button>
            </Input.Addon>
        </Input.Group>
    );
}

/** Lines of text saved on blur. */
export function CommitTextarea({
    value,
    placeholder,
    label,
    onCommit
}: {
    value: string;
    placeholder?: string;
    label?: string;
    onCommit: (value: string) => void;
}) {
    const [draft, setDraft] = useState<string | null>(null);
    return (
        <Textarea
            value={draft ?? value}
            placeholder={placeholder}
            aria-label={label}
            spellCheck={false}
            rows={3}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => {
                if (draft !== null && draft !== value) onCommit(draft);
                setDraft(null);
            }}
            className="w-full"
        />
    );
}
