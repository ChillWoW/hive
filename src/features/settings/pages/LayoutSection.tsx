import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import {
    ArrowsLeftRightIcon,
    ChatsCircleIcon,
    ChatTextIcon,
    GearSixIcon,
    TabsIcon
} from "@phosphor-icons/react";
import { mirrorLayout, moveColumn, normalizeLayout } from "@/layout/placement";
import { cn } from "@/lib/cn";
import { Button, FolderTreeIcon } from "@/ui";
import { matchesQuery, useSettingsQuery } from "../search";
import { SettingRow, SettingsSection } from "../SettingsSection";
import { useSetting } from "../store";
import type { LayoutColumn } from "../types";

const ROW = {
    label: "Panels",
    description: "Drag the dock and panels to either side of the chat, in any order",
    keywords:
        "layout panels position place order arrange move swap mirror flip side left right dock sidebar chats tabs files"
};

const LABELS: Record<LayoutColumn, string> = {
    dock: "Dock",
    chats: "Chats",
    main: "Chat",
    tabs: "Tabs",
    files: "Files"
};

/** Where the dock and panels sit (`appearance.layout`), on a miniature of the window. */
export function LayoutSection() {
    const layout = useSetting("appearance", "layout");
    const query = useSettingsQuery();

    return (
        <SettingsSection title="Layout">
            <SettingRow
                {...ROW}
                setting={layout}
                controlClassName="w-auto"
                control={
                    <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => layout.set(mirrorLayout(layout.value))}
                    >
                        <ArrowsLeftRightIcon />
                        Swap sides
                    </Button>
                }
            />
            {/* Part of the row above, so it hides with it. */}
            {matchesQuery(query, ROW.label, ROW.description, ROW.keywords) && (
                <div className="px-4 pb-4">
                    <LayoutEditor value={layout.value} onChange={layout.set} />
                </div>
            )}
        </SettingsSection>
    );
}

/**
 * The window's columns as tiles. Dragging one reorders them live and saves on
 * release; the arrow keys move a focused one. The chat column stays put while
 * the others move around it, and the dock only goes to an end.
 */
function LayoutEditor({
    value,
    onChange
}: {
    value: LayoutColumn[];
    onChange: (layout: LayoutColumn[]) => void;
}) {
    const row = useRef<HTMLDivElement>(null);
    const tiles = useRef(new Map<LayoutColumn, HTMLElement>());
    const [drag, setDrag] = useState<{ column: LayoutColumn; order: LayoutColumn[] } | null>(
        null
    );
    const columns = drag?.order ?? normalizeLayout(value);

    const start = (column: LayoutColumn, event: PointerEvent) => {
        if (event.button !== 0 || column === "main") return;
        event.preventDefault();
        // The row holds the capture: React moves the tile's node as it reorders, which would drop it.
        row.current?.setPointerCapture(event.pointerId);
        setDrag({ column, order: columns });
    };

    const move = (event: PointerEvent) => {
        if (!drag) return;
        // The dragged tile goes after every other tile whose middle the pointer is past.
        const index = columns.filter((c) => {
            if (c === drag.column) return false;
            const rect = tiles.current.get(c)?.getBoundingClientRect();
            return rect ? rect.left + rect.width / 2 < event.clientX : false;
        }).length;
        const order = moveColumn(columns, drag.column, index);
        if (order.join() !== columns.join()) setDrag({ ...drag, order });
    };

    const end = () => {
        if (!drag) return;
        if (drag.order.join() !== normalizeLayout(value).join()) onChange(drag.order);
        setDrag(null);
    };

    const nudge = (column: LayoutColumn, event: KeyboardEvent) => {
        const step = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
        if (!step) return;
        event.preventDefault();
        const at = columns.indexOf(column);
        // The dock hops between the ends.
        const index = column === "dock" ? (step < 0 ? 0 : columns.length) : at + step;
        const order = moveColumn(columns, column, index);
        if (order.join() === columns.join()) return;
        onChange(order);
        // Reordering moves the node, which can drop its focus.
        requestAnimationFrame(() => tiles.current.get(column)?.focus());
    };

    return (
        <div
            ref={row}
            onPointerMove={move}
            onPointerUp={end}
            onPointerCancel={end}
            aria-label="Window layout"
            className={cn(
                "flex h-24 touch-none gap-1 rounded-md border border-border bg-surface p-1 select-none",
                drag && "cursor-grabbing"
            )}
        >
            {columns.map((column) => (
                <Tile
                    key={column}
                    column={column}
                    side={columns.indexOf(column) < columns.indexOf("main") ? "left" : "right"}
                    dragging={drag?.column === column}
                    ref={(node) => {
                        if (node) tiles.current.set(column, node);
                        else tiles.current.delete(column);
                    }}
                    onPointerDown={(event) => start(column, event)}
                    onKeyDown={(event) => nudge(column, event)}
                />
            ))}
        </div>
    );
}

function Tile({
    column,
    side,
    dragging,
    ref,
    onPointerDown,
    onKeyDown
}: {
    column: LayoutColumn;
    side: "left" | "right";
    dragging: boolean;
    ref: (node: HTMLElement | null) => void;
    onPointerDown: (event: PointerEvent) => void;
    onKeyDown: (event: KeyboardEvent) => void;
}) {
    if (column === "main") {
        return (
            <div
                ref={ref}
                className="flex min-w-24 flex-1 flex-col items-center justify-center gap-1 rounded-sm border border-dashed border-border bg-bg text-xs text-muted"
            >
                <ChatTextIcon className="size-4" />
                {LABELS.main}
            </div>
        );
    }

    const label = LABELS[column];
    return (
        <button
            ref={ref}
            type="button"
            aria-label={`${label}, ${side} of the chat`}
            aria-roledescription="movable panel"
            aria-keyshortcuts="ArrowLeft ArrowRight"
            onPointerDown={onPointerDown}
            onKeyDown={onKeyDown}
            className={cn(
                "flex shrink-0 cursor-grab flex-col items-center rounded-sm border border-border bg-raised text-xs text-muted outline-none",
                "transition-[color,background-color,box-shadow] duration-150 hover:bg-hover hover:text-text",
                "focus-visible:ring-2 focus-visible:ring-accent",
                column === "dock" ? "w-9 justify-between py-2" : "w-20 justify-center gap-1",
                dragging && "cursor-grabbing bg-hover text-text shadow-lg ring-1 ring-accent"
            )}
        >
            {column === "dock" ? (
                // A miniature of the dock itself: views at the top, settings at the foot.
                <>
                    <ChatsCircleIcon className="size-4" />
                    <GearSixIcon className="size-4" />
                </>
            ) : (
                <>
                    {column === "files" ? (
                        <FolderTreeIcon className="size-4" />
                    ) : column === "tabs" ? (
                        <TabsIcon className="size-4" />
                    ) : (
                        <ChatsCircleIcon className="size-4" />
                    )}
                    {label}
                </>
            )}
        </button>
    );
}
