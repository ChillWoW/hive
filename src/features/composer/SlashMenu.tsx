import { useEffect, useRef } from "react";
import { BookOpenIcon, TerminalIcon } from "@phosphor-icons/react";
import type { SlashCommand } from "@/proto";
import { cn } from "@/lib/cn";

/**
 * The commands a leading `/` matches, above the composer: ↑/↓ move, Enter
 * or Tab pick, Escape closes. Skills are marked as such.
 */
export function SlashMenu({
    commands,
    highlighted,
    onHighlight,
    onPick
}: {
    commands: SlashCommand[];
    highlighted: number;
    onHighlight: (index: number) => void;
    onPick: (command: SlashCommand) => void;
}) {
    const listRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        listRef.current?.querySelector(`[data-index="${highlighted}"]`)?.scrollIntoView({ block: "nearest" });
    }, [highlighted]);

    return (
        <div
            role="listbox"
            aria-label="Commands"
            className={cn(
                "absolute inset-x-0 bottom-full z-20 mb-2 overflow-hidden rounded-xl border border-border bg-surface shadow-lg shadow-shadow/30",
                "origin-bottom transition-[opacity,scale] duration-150 ease-out starting:scale-95 starting:opacity-0"
            )}
        >
            <div ref={listRef} className="flex max-h-72 flex-col overflow-y-auto p-1">
                {commands.map((command, index) => {
                    const Icon = command.kind === "skill" ? BookOpenIcon : TerminalIcon;
                    return (
                        <div
                            key={`${command.kind}:${command.name}`}
                            role="option"
                            aria-selected={index === highlighted}
                            data-index={index}
                            onMouseMove={() => onHighlight(index)}
                            onMouseDown={(event) => {
                                // Keeps the field focused.
                                event.preventDefault();
                                onPick(command);
                            }}
                            className={cn(
                                "flex min-h-8 cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs",
                                index === highlighted ? "bg-hover" : ""
                            )}
                        >
                            <Icon className="size-3.5 shrink-0 text-muted" />
                            <span className="shrink-0 font-medium text-text">
                                {command.kind === "skill" ? "$" : "/"}
                                {command.name}
                            </span>
                            {command.inputHint && (
                                <span className="shrink-0 text-[11px] text-muted/60">{command.inputHint}</span>
                            )}
                            <span className="min-w-0 truncate text-[11px] text-muted/75">{command.description}</span>
                            {command.kind === "skill" && (
                                <span className="ml-auto shrink-0 rounded-sm bg-raised px-1.5 py-px text-[10px] text-muted">
                                    Skill
                                </span>
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
