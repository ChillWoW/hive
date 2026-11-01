import { useEffect, useRef, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import type { CompletionMenuState } from "./useCompletionMenu";

/**
 * A completion menu's list (the `/`, `$` and `@` menus): its matches as
 * options, the highlighted one kept in view, `empty` said when none match.
 * Pressing an option keeps focus in the field.
 */
export function CompletionMenu<T>({
    menu,
    label,
    empty,
    itemKey,
    itemClassName,
    renderItem,
    className
}: {
    menu: CompletionMenuState<T>;
    label: string;
    empty: ReactNode;
    itemKey: (item: T) => string;
    itemClassName: string;
    renderItem: (item: T) => ReactNode;
    className?: string;
}) {
    const listRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        listRef.current?.querySelector("[data-active]")?.scrollIntoView({ block: "nearest" });
    }, [menu.index, menu.matches]);

    if (!menu.open) return null;

    return (
        <div
            ref={listRef}
            role="listbox"
            aria-label={label}
            className={cn(
                "hide-scrollbar overflow-y-auto rounded-md border border-dark-600 bg-dark-850 p-1 shadow-lg shadow-black/40",
                "transition-[opacity,translate] duration-150 ease-out starting:translate-y-1 starting:opacity-0",
                className
            )}
        >
            {menu.matches.length === 0 && (
                <p className="px-2 py-1.5 text-xs text-dark-250">{empty}</p>
            )}
            {menu.matches.map((item, i) => (
                <button
                    key={itemKey(item)}
                    type="button"
                    role="option"
                    aria-selected={i === menu.index}
                    data-active={i === menu.index || undefined}
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseEnter={() => menu.setIndex(i)}
                    onClick={() => menu.pick(item)}
                    className={cn(
                        "flex w-full gap-2 rounded-sm px-2 py-1.5 text-left text-xs outline-none data-active:bg-dark-700",
                        itemClassName
                    )}
                >
                    {renderItem(item)}
                </button>
            ))}
        </div>
    );
}
