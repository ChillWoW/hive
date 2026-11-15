import { useEffect, useRef, type KeyboardEvent } from "react";

type InlineRenameOptions = {
    /** Once focused, what to select; the whole value by default. */
    select?: (input: HTMLInputElement) => void;
    onEnter: () => void;
    onEscape: () => void;
    /** Focus leaving the field. */
    onBlur: () => void;
};

/**
 * A name edited in place (a chat's title, a file tree entry): the field takes
 * focus on the next frame, after a menu's own focus handling settles; Enter,
 * Escape and leaving it call back. `finish` runs its callback at most once,
 * however the edit ends first. Spread `inputProps` on the `<input>`.
 */
export function useInlineRename({ select, onEnter, onEscape, onBlur }: InlineRenameOptions) {
    const input = useRef<HTMLInputElement>(null);
    const done = useRef(false);

    useEffect(() => {
        const frame = requestAnimationFrame(() => {
            const field = input.current;
            if (!field) return;
            field.focus();
            if (select) select(field);
            else field.select();
        });
        return () => cancelAnimationFrame(frame);
        // Once, on mount: the field is gone when the edit ends.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const finish = (end: () => void) => {
        if (done.current) return;
        done.current = true;
        end();
    };

    /** The field's text, trimmed. */
    const value = () => input.current?.value.trim() ?? "";

    const inputProps = {
        ref: input,
        onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => {
            if (event.key === "Enter") onEnter();
            else if (event.key === "Escape") onEscape();
        },
        onBlur
    };

    return { input, finish, value, inputProps };
}
