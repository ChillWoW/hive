import { useEffect, useRef } from "react";
import { cn } from "@/lib/cn";
import { HiveMark } from "@/ui";
import { ITEM_PREFIX } from "./slashCommands";
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
            aria-label={menu.kind === "skill" ? "Skills" : "Commands"}
            className={cn(
                "hide-scrollbar max-h-64 overflow-y-auto rounded-md border border-dark-600 bg-dark-850 p-1 shadow-lg shadow-black/40",
                "transition-[opacity,translate] duration-150 ease-out starting:translate-y-1 starting:opacity-0",
                className
            )}
        >
            {menu.matches.length === 0 && (
                <p className="px-2 py-1.5 text-xs text-dark-250">
                    {menu.kind === "skill"
                        ? "No matching skill. Try / to browse commands."
                        : "No matching command."}
                </p>
            )}
            {menu.matches.map((item, i) => (
                <button
                    key={`${item.type}:${item.name}`}
                    type="button"
                    role="option"
                    aria-selected={i === menu.index}
                    data-active={i === menu.index || undefined}
                    // Keeps focus in the field.
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseEnter={() => menu.setIndex(i)}
                    onClick={() => menu.pick(item)}
                    className="flex w-full items-baseline gap-2 rounded-sm px-2 py-1.5 text-left text-xs outline-none data-active:bg-dark-700"
                >
                    <span className="max-w-[45%] shrink-0 truncate font-medium text-dark-50">
                        {ITEM_PREFIX[item.type]}
                        {item.name}
                    </span>
                    {item.type !== "app" && item.inputHint && (
                        <span className="shrink-0 text-dark-250">{item.inputHint}</span>
                    )}
                    <span className="min-w-0 flex-1 truncate text-dark-200">
                        {item.description}
                    </span>
                    {item.type === "app" && (
                        <HiveMark className="size-3 shrink-0 self-center text-dark-250" />
                    )}
                    {item.type === "skill" && menu.kind === "command" && (
                        <span className="shrink-0 self-center rounded-sm bg-dark-700 px-1 text-[10px] leading-4 text-dark-200">
                            Skill
                        </span>
                    )}
                </button>
            ))}
        </div>
    );
}
