import { useEffect, useId, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { MagnifyingGlassIcon } from "@phosphor-icons/react";
import { cardRowClassName, cardSearchClassName, searchInputClassName } from "@/ui/chip";

/**
 * A card's rows, driven from its search: the highlighted one follows ↑↓ and
 * the pointer, Enter picks it. Until either moves, it's the card's own pick
 * (`own`), or the first match while `filtering`.
 */
export function useRows(keys: string[], own: string | null, filtering: boolean) {
    const id = useId();
    const [cursor, setCursor] = useState<string | null>(null);
    const active =
        cursor !== null && keys.includes(cursor)
            ? cursor
            : !filtering && own !== null && keys.includes(own)
              ? own
              : (keys[0] ?? null);
    const idOf = (key: string) => `${id}-${keys.indexOf(key)}`;
    const activeId = active !== null ? idOf(active) : undefined;

    useEffect(() => {
        if (activeId) document.getElementById(activeId)?.scrollIntoView({ block: "nearest" });
    }, [activeId]);

    return {
        listId: id,
        activeId,
        /** Back to the card's own pick, as the search changes. */
        reset: () => setCursor(null),
        /** True when the key was one of the list's. */
        onKeyDown: (event: KeyboardEvent, pick: (key: string) => void) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                if (!keys.length) return true;
                const at = active === null ? -1 : keys.indexOf(active);
                const next = Math.min(keys.length - 1, Math.max(0, at + (event.key === "ArrowDown" ? 1 : -1)));
                setCursor(keys[next]!);
                return true;
            }
            if (event.key === "Enter") {
                event.preventDefault();
                if (active !== null) pick(active);
                return true;
            }
            return false;
        },
        /** A row's props: its place under the keyboard and the pointer. */
        row: (key: string, selected: boolean, onPick: () => void, disabled = false) => ({
            id: idOf(key),
            role: "option" as const,
            "aria-selected": selected,
            "aria-disabled": disabled || undefined,
            "data-highlighted": key === active ? "" : undefined,
            "data-disabled": disabled ? "" : undefined,
            // The search keeps the focus, and no `mousedown` follows: the row's
            // "⋯" opens on its click alone. Its menu is elsewhere in the page.
            onPointerDownCapture: (event: PointerEvent) => {
                if (event.currentTarget.contains(event.target as Node)) event.preventDefault();
            },
            onPointerMove: () => {
                if (key !== active) setCursor(key);
            },
            onClick: () => {
                if (!disabled) onPick();
            },
            className: cardRowClassName
        })
    };
}

/** The search on top of a card, edge to edge, with what sits at its end. */
export function CardSearch({
    id,
    value,
    onChange,
    onKeyDown,
    placeholder,
    controls,
    activeId,
    children
}: {
    id?: string;
    value: string;
    onChange: (value: string) => void;
    onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
    placeholder: string;
    /** The list it drives. */
    controls: string;
    activeId: string | undefined;
    children?: ReactNode;
}) {
    return (
        <div className={cardSearchClassName}>
            <MagnifyingGlassIcon className="size-3.5 shrink-0 text-muted/75" />
            <input
                id={id}
                autoFocus
                role="combobox"
                aria-expanded
                aria-controls={controls}
                aria-activedescendant={activeId}
                aria-label={placeholder}
                value={value}
                onChange={(event) => onChange(event.target.value)}
                onKeyDown={onKeyDown}
                placeholder={placeholder}
                spellCheck={false}
                autoComplete="off"
                className={searchInputClassName}
            />
            {children}
        </div>
    );
}
