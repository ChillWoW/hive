import { useEffect, useRef } from "react";
import { cn } from "@/lib/cn";
import { FileIcon } from "@/ui";
import type { MentionMenuState } from "./mentions";

/** The `@` menu above the composer: the matching files and folders, each with its parent folder. */
export function MentionMenu({ menu }: { menu: MentionMenuState }) {
    const { matches, highlighted, setHighlighted, pick } = menu;
    const listRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        listRef.current?.querySelector(`[data-index="${highlighted}"]`)?.scrollIntoView({ block: "nearest" });
    }, [highlighted]);

    return (
        <div
            role="listbox"
            aria-label="Files"
            className={cn(
                "absolute inset-x-0 bottom-full z-20 mb-2 overflow-hidden rounded-xl border border-border bg-surface shadow-lg shadow-shadow/30",
                "origin-bottom transition-[opacity,scale] duration-150 ease-out starting:scale-95 starting:opacity-0"
            )}
        >
            <div ref={listRef} className="flex max-h-72 flex-col overflow-y-auto p-1">
                {matches.length === 0 && (
                    <div className="px-2.5 py-1.5 text-xs text-muted">
                        {menu.loading ? "Listing files…" : "No matching files"}
                    </div>
                )}
                {matches.map((entry, index) => {
                    const slash = entry.path.lastIndexOf("/");
                    const name = entry.path.slice(slash + 1);
                    const parent = slash === -1 ? "" : entry.path.slice(0, slash);
                    return (
                        <div
                            key={entry.path}
                            role="option"
                            aria-selected={index === highlighted}
                            data-index={index}
                            onMouseMove={() => setHighlighted(index)}
                            onMouseDown={(event) => {
                                // Keeps the field focused.
                                event.preventDefault();
                                pick(entry);
                            }}
                            className={cn(
                                "flex min-h-8 min-w-0 cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs",
                                index === highlighted ? "bg-hover" : ""
                            )}
                        >
                            <FileIcon name={name} folder={entry.dir} className="size-3.5" />
                            <span className="max-w-[70%] shrink-0 truncate font-medium text-text">
                                {name}
                                {entry.dir && "/"}
                            </span>
                            {parent && <span className="min-w-0 truncate text-[11px] text-muted/75">{parent}</span>}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
