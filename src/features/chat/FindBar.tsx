import { useEffect } from "react";
import { ArrowDownIcon, ArrowUpIcon, MagnifyingGlassIcon, XIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/cn";
import { IconButton } from "@/ui";
import type { TranscriptFind } from "./find";

/** Find in chat, over the transcript's top right corner: the query, "3 of 12", previous, next, close. */
export function FindBar({ find }: { find: TranscriptFind }) {
    const { inputRef, query, count, index } = find;

    useEffect(() => {
        // A query left from last time is there to type over.
        inputRef.current?.select();
    }, [inputRef]);

    const status = !query
        ? ""
        : count === 0
          ? "No results"
          : `${index >= 0 ? `${index + 1} of ` : ""}${count}${find.capped ? "+" : ""}`;

    return (
        <div
            role="search"
            className="absolute top-2 right-6 z-10 flex w-80 max-w-[calc(100%-3rem)] items-center gap-0.5 rounded-lg border border-border bg-surface p-1 shadow-lg shadow-shadow/40"
        >
            <label
                className={cn(
                    "flex h-7 min-w-0 flex-1 cursor-text items-center gap-1.5 rounded-md border border-border bg-bg px-2",
                    "transition-colors focus-within:border-muted/50"
                )}
            >
                <MagnifyingGlassIcon className="size-3 shrink-0 text-muted" />
                <input
                    ref={inputRef}
                    type="text"
                    value={query}
                    onChange={(event) => find.setQuery(event.target.value)}
                    onKeyDown={(event) => {
                        if (event.key === "Escape") {
                            event.preventDefault();
                            find.close();
                        } else if (event.key === "Enter") {
                            event.preventDefault();
                            if (event.shiftKey) find.previous();
                            else find.next();
                        }
                    }}
                    placeholder="Find in chat"
                    aria-label="Find in chat"
                    spellCheck={false}
                    autoComplete="off"
                    className="min-w-0 flex-1 bg-transparent text-xs text-text outline-none placeholder:text-muted/70"
                />
                <span aria-live="polite" className="shrink-0 text-[11px] text-muted tabular-nums">
                    {status}
                </span>
            </label>
            <IconButton label="Previous match" shortcut="Shift+Enter" disabled={count === 0} onClick={find.previous}>
                <ArrowUpIcon className="size-3.5" />
            </IconButton>
            <IconButton label="Next match" shortcut="Enter" disabled={count === 0} onClick={find.next}>
                <ArrowDownIcon className="size-3.5" />
            </IconButton>
            <IconButton label="Close" shortcut="Escape" onClick={find.close}>
                <XIcon className="size-3.5" />
            </IconButton>
        </div>
    );
}
