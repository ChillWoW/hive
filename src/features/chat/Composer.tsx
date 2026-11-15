import { useLayoutEffect, useRef, useState } from "react";
import { ArrowUpIcon, StopIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/cn";

/** Rows the field grows to before it scrolls. */
const MAX_ROWS = 12;
const LINE_HEIGHT = 24;

/**
 * The prompt box: a field that grows with what's typed, and one button that
 * is Send while idle and Stop while a turn runs. Enter sends, Shift+Enter
 * breaks the line, Escape stops. While `busy`, typing still works but
 * nothing goes out.
 */
export function Composer({
    onSend,
    onStop,
    busy = false,
    placeholder = "Ask anything",
    autoFocus,
    className
}: {
    onSend: (prompt: string) => void;
    onStop?: () => void;
    busy?: boolean;
    placeholder?: string;
    autoFocus?: boolean;
    className?: string;
}) {
    const [draft, setDraft] = useState("");
    const fieldRef = useRef<HTMLTextAreaElement>(null);
    const canSend = !busy && draft.trim().length > 0;

    useLayoutEffect(() => {
        const field = fieldRef.current;
        if (!field) return;
        field.style.height = "auto";
        field.style.height = `${Math.min(field.scrollHeight, MAX_ROWS * LINE_HEIGHT)}px`;
    }, [draft]);

    const send = () => {
        if (!canSend) return;
        onSend(draft);
        setDraft("");
    };

    return (
        <form
            className={cn(
                "flex items-end gap-2 rounded-xl border border-border bg-surface p-2 pl-3.5",
                "transition-colors focus-within:border-muted/60",
                className
            )}
            onSubmit={(e) => {
                e.preventDefault();
                if (busy) onStop?.();
                else send();
            }}
            onClick={() => fieldRef.current?.focus()}
        >
            <textarea
                ref={fieldRef}
                rows={1}
                value={draft}
                autoFocus={autoFocus}
                placeholder={placeholder}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                        e.preventDefault();
                        send();
                    } else if (e.key === "Escape" && busy) {
                        e.preventDefault();
                        onStop?.();
                    }
                }}
                className="my-0.5 min-w-0 flex-1 resize-none bg-transparent text-sm leading-6 text-text outline-none placeholder:text-muted"
            />
            <button
                type="submit"
                aria-label={busy ? "Stop" : "Send"}
                disabled={busy ? !onStop : !canSend}
                className={cn(
                    "inline-flex size-7 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-fg",
                    "transition-opacity hover:opacity-90 disabled:opacity-30"
                )}
            >
                {busy ? (
                    <StopIcon weight="fill" className="size-3" />
                ) : (
                    <ArrowUpIcon weight="bold" className="size-3.5" />
                )}
            </button>
        </form>
    );
}
