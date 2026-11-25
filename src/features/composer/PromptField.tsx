import { useImperativeHandle, useLayoutEffect, useRef, type KeyboardEvent, type Ref } from "react";
import { cn } from "@/lib/cn";
import { useResizeObserver } from "@/lib/useResizeObserver";

/** Rows the field grows to before it scrolls. */
const MAX_ROWS = 12;
const LINE_HEIGHT = 24;

export type PromptFieldHandle = {
    dom: HTMLTextAreaElement | null;
    /** Takes focus; `"end"` puts the caret after the text. */
    focus: (at?: "end") => void;
    /** Replaces the text, the caret at `caret` (its end by default). */
    setText: (text: string, caret?: number) => void;
};

/**
 * The composer's text field: plain text that grows with what's typed up to
 * `MAX_ROWS`, then scrolls. `onKeyDown` sees each key first; returning true
 * means it was taken.
 */
export function PromptField({
    ref,
    value,
    placeholder,
    onChange,
    onFocusChange,
    onKeyDown,
    className
}: {
    ref?: Ref<PromptFieldHandle>;
    value: string;
    placeholder?: string;
    onChange: (text: string) => void;
    onFocusChange?: (focused: boolean) => void;
    onKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;
    className?: string;
}) {
    const fieldRef = useRef<HTMLTextAreaElement>(null);

    useImperativeHandle(ref, () => ({
        get dom() {
            return fieldRef.current;
        },
        focus: (at) => {
            const field = fieldRef.current;
            if (!field) return;
            field.focus();
            if (at === "end") field.setSelectionRange(field.value.length, field.value.length);
        },
        setText: (text, caret = text.length) => {
            const field = fieldRef.current;
            onChange(text);
            // After React writes the value.
            requestAnimationFrame(() => field?.setSelectionRange(caret, caret));
        }
    }));

    /** Fits the height to the text, up to `MAX_ROWS`. */
    const fit = (field: HTMLTextAreaElement) => {
        field.style.height = "auto";
        field.style.height = `${Math.min(field.scrollHeight, MAX_ROWS * LINE_HEIGHT)}px`;
    };

    useLayoutEffect(() => {
        if (fieldRef.current) fit(fieldRef.current);
    }, [value]);

    // A new width rewraps the text (the composer changing shape): refit, but
    // not for the height changes `fit` itself makes.
    const widthRef = useRef(0);
    useResizeObserver(fieldRef, (field) => {
        if (field.clientWidth === widthRef.current) return;
        widthRef.current = field.clientWidth;
        fit(field);
    });

    return (
        <textarea
            ref={fieldRef}
            rows={1}
            value={value}
            placeholder={placeholder}
            spellCheck={false}
            onChange={(event) => onChange(event.target.value)}
            onFocus={() => onFocusChange?.(true)}
            onBlur={() => onFocusChange?.(false)}
            onKeyDown={(event) => {
                if (onKeyDown?.(event)) event.preventDefault();
            }}
            className={cn(
                "resize-none bg-transparent py-1 outline-none placeholder:text-muted/75",
                className
            )}
        />
    );
}
