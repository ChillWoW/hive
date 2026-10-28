import { useEffect, useRef } from "react";
import { cn } from "@/lib/cn";
import type { SlashMenuState } from "./useSlashMenu";

export function SlashMenu({
    menu,
    className
}: {
    menu: SlashMenuState;
    className?: string;
}) {
    const listRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        listRef.current
            ?.querySelector("[data-active]")
            ?.scrollIntoView({ block: "nearest" });
    }, [menu.index]);

    if (!menu.open) return null;

    return (
        <div
            ref={listRef}
            role="listbox"
            aria-label="Commands"
            className={cn(
                "hide-scrollbar max-h-64 overflow-y-auto rounded-md border border-dark-600 bg-dark-850 p-1 shadow-lg shadow-black/40",
                "transition-[opacity,translate] duration-150 ease-out starting:translate-y-1 starting:opacity-0",
                className
            )}
        >
            {menu.matches.map((command, i) => (
                <button
                    key={command.name}
                    type="button"
                    role="option"
                    aria-selected={i === menu.index}
                    data-active={i === menu.index || undefined}
                    // Keeps focus in the field.
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseEnter={() => menu.setIndex(i)}
                    onClick={() => menu.pick(command)}
                    className="flex w-full items-baseline gap-2 rounded-sm px-2 py-1.5 text-left text-xs outline-none data-active:bg-dark-700"
                >
                    <span className="shrink-0 font-medium text-dark-50">
                        /{command.name}
                    </span>
                    {command.inputHint && (
                        <span className="shrink-0 text-dark-300">
                            {command.inputHint}
                        </span>
                    )}
                    <span className="min-w-0 truncate text-dark-200">
                        {command.description}
                    </span>
                </button>
            ))}
        </div>
    );
}
