import { useState, type KeyboardEvent, type MouseEvent } from "react";
import type { TranscriptMessage } from "@/chats";
import { cn } from "@/lib/cn";
import { splitDiffComments } from "@/review/comments";
import type { MinimapItem } from "./minimapItems";
import { promptText } from "./text";

/** A tick per prompt, this far apart while the rail fits. */
const SPACING = 8;
/** Fewer prompts than this, no minimap. */
const MIN_ITEMS = 2;
/** How much of a long reply the preview reads. */
const PREVIEW_CHARS = 1500;
/** Hit area above the first tick and below the last, in px. */
const PAD = 12;

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

/** Markdown read as plain words, roughly: enough for three lines of preview. */
function plain(markdown: string): string {
    return oneLine(
        markdown
            .slice(0, PREVIEW_CHARS)
            .replace(/```[^\n]*\n[\s\S]*?(```|$)/g, " ")
            .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
            .replace(/<[^>]+>/g, " ")
            .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, "")
            .replace(/(\*\*|__|~~|[*_`])/g, "")
    );
}

function promptPreview(message: TranscriptMessage): string {
    const text = oneLine(splitDiffComments(promptText(message)).prompt);
    if (text) return text;
    const files = message.attachments?.map((a) => a.name) ?? [];
    return files.length ? files.join(", ") : "Prompt";
}

function replyPreview(message: TranscriptMessage | undefined): string {
    if (!message) return "";
    return plain(message.parts.flatMap((p) => (p.kind === "text" ? [p.text] : [])).join("\n\n"));
}

const topPercent = (index: number, count: number) => (count <= 1 ? 50 : (index / (count - 1)) * 100);

/** Narrower the further a tick is from the hovered one. */
const SCALES = ["scale-x-100", "scale-x-[0.667]", "scale-x-[0.417]"];

/**
 * The transcript's prompts as ticks down its left edge: the turns in view
 * are lit (the transcript sets
 * `data-in-view` on the ticks it's handed in `ticks`), hovering one previews
 * its prompt and reply, a click jumps there. Wheel over it scrolls the
 * transcript.
 */
export function Minimap({
    items,
    ticks,
    onSelect,
    onWheel
}: {
    items: MinimapItem[];
    ticks: Map<string, HTMLSpanElement>;
    onSelect: (item: MinimapItem) => void;
    onWheel: (deltaY: number) => void;
}) {
    const [active, setActive] = useState<number | null>(null);
    const count = items.length;
    const shown = active !== null && active < count ? active : null;
    const activeItem = shown === null ? null : items[shown];

    if (count < MIN_ITEMS) return null;

    // The button is the rail plus `PAD` above and below, so the end ticks
    // aren't half outside it; the pad counts as the nearest end.
    const indexAt = (event: MouseEvent<HTMLElement>) => {
        const rect = event.currentTarget.getBoundingClientRect();
        const height = rect.height - 2 * PAD;
        const ratio = height > 0 ? (event.clientY - rect.top - PAD) / height : 0;
        return Math.max(0, Math.min(count - 1, Math.round(ratio * (count - 1))));
    };
    const railHeight = `min(${Math.max(1, (count - 1) * SPACING)}px, 100% - 4rem)`;

    const onKeyDown = (event: KeyboardEvent) => {
        const move = (to: number) => {
            event.preventDefault();
            setActive(Math.max(0, Math.min(count - 1, to)));
        };
        if (event.key === "ArrowDown") move((shown ?? -1) + 1);
        else if (event.key === "ArrowUp") move((shown ?? count) - 1);
        else if (event.key === "Home") move(0);
        else if (event.key === "End") move(count - 1);
        else if ((event.key === "Enter" || event.key === " ") && activeItem) {
            event.preventDefault();
            onSelect(activeItem);
        }
    };

    const reply = activeItem ? replyPreview(activeItem.reply) : "";
    const top = shown === null ? 0 : topPercent(shown, count);

    return (
        <div className="pointer-events-none absolute inset-y-0 left-0 z-20 flex w-10 items-center">
            <button
                type="button"
                aria-label={activeItem ? `Jump to: ${promptPreview(activeItem.prompt)}` : "Jump to a prompt"}
                className="pointer-events-auto relative w-10 cursor-pointer rounded-sm outline-none focus-visible:ring-1 focus-visible:ring-primary-400/70"
                style={{ height: `calc(${railHeight} + ${2 * PAD}px)` }}
                onMouseMove={(event) => setActive(indexAt(event))}
                onMouseLeave={() => setActive(null)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={(event) => {
                    // What the preview shows is what a click opens.
                    const item = items[event.detail > 0 ? indexAt(event) : (shown ?? count - 1)];
                    if (item) onSelect(item);
                }}
                onFocus={() => setActive((current) => current ?? count - 1)}
                onBlur={() => setActive(null)}
                onKeyDown={onKeyDown}
                onWheel={(event) => onWheel(event.deltaY)}
            >
                <span className="pointer-events-none absolute right-0 left-2.5" style={{ top: PAD, bottom: PAD }}>
                {items.map((item, index) => {
                    const distance = shown === null ? null : Math.abs(index - shown);
                    return (
                        // Only transform and opacity change: the lit band moves
                        // on every scroll tick.
                        <span
                            key={item.id}
                            aria-hidden="true"
                            ref={(node) => {
                                if (node) ticks.set(item.id, node);
                                else ticks.delete(item.id);
                            }}
                            data-in-view="false"
                            className={cn(
                                "absolute left-0 h-0.5 w-4 origin-left -translate-y-1/2 rounded-full transition-transform duration-150",
                                "after:absolute after:inset-0 after:rounded-full after:bg-dark-100 after:opacity-0 after:transition-opacity after:duration-150 data-[in-view=true]:after:opacity-100",
                                distance === 0 ? "bg-dark-200" : "bg-dark-500",
                                distance === null ? SCALES[2] : (SCALES[distance] ?? "scale-x-[0.333]")
                            )}
                            style={{ top: `${topPercent(index, count)}%` }}
                        />
                    );
                })}
                </span>
            </button>
            {activeItem && (
                <div
                    className="absolute left-10 w-80 rounded-md border border-dark-600 bg-dark-850 px-3 py-2.5 shadow-lg shadow-black/40"
                    style={{
                        // The rail is centred, so its percentages map onto the
                        // middle of this box the same way.
                        top: `calc(50% + (${top / 100} - 0.5) * ${railHeight})`,
                        transform: `translateY(${shown === 0 ? "-12px" : shown === count - 1 ? "calc(-100% + 12px)" : "-50%"})`
                    }}
                >
                    <p className="truncate text-xs font-medium text-dark-50">{promptPreview(activeItem.prompt)}</p>
                    {reply && <p className="mt-1 line-clamp-3 text-xs leading-[1.125rem] text-dark-250">{reply}</p>}
                </div>
            )}
        </div>
    );
}
