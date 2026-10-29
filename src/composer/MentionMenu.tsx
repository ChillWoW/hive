import { useEffect, useRef } from "react";
import { cn } from "@/lib/cn";
import { FileIcon } from "@/ui";
import type { MentionMenuState } from "./useMentionMenu";

/** The `@` menu: the matching files and folders, each with its parent folder. */
export function MentionMenu({
    menu,
    className
}: {
    menu: MentionMenuState;
    className?: string;
}) {
    const listRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        listRef.current
            ?.querySelector("[data-active]")
            ?.scrollIntoView({ block: "nearest" });
    }, [menu.index, menu.matches]);

    if (!menu.open) return null;

    const empty = menu.matches.length === 0;

    return (
        <div
            ref={listRef}
            role="listbox"
            aria-label="Files"
            className={cn(
                "hide-scrollbar max-h-72 overflow-y-auto rounded-md border border-dark-600 bg-dark-850 p-1 shadow-lg shadow-black/40",
                "transition-[opacity,translate] duration-150 ease-out starting:translate-y-1 starting:opacity-0",
                className
            )}
        >
            {empty && (
                <div className="px-2 py-1.5 text-xs text-dark-300">
                    {menu.loading ? "Listing files…" : "No matching files"}
                </div>
            )}
            {menu.matches.map((entry, i) => {
                const slash = entry.path.lastIndexOf("/");
                const name = entry.path.slice(slash + 1);
                const parent = slash === -1 ? "" : entry.path.slice(0, slash);
                return (
                    <button
                        key={entry.path}
                        type="button"
                        role="option"
                        aria-selected={i === menu.index}
                        data-active={i === menu.index || undefined}
                        // Keeps focus in the field.
                        onMouseDown={(event) => event.preventDefault()}
                        onMouseEnter={() => menu.setIndex(i)}
                        onClick={() => menu.pick(entry)}
                        className="flex w-full min-w-0 items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs outline-none data-active:bg-dark-700"
                    >
                        <FileIcon name={name} folder={entry.dir} className="size-3.5" />
                        <span className="max-w-[70%] shrink-0 truncate text-dark-50">
                            {name}
                            {entry.dir && "/"}
                        </span>
                        {parent && (
                            <span className="min-w-0 truncate text-dark-300">{parent}</span>
                        )}
                    </button>
                );
            })}
        </div>
    );
}
