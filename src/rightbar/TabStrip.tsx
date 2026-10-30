import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
    ClockCounterClockwiseIcon,
    GitCommitIcon,
    GitDiffIcon,
    PlusIcon,
    TerminalWindowIcon,
    XIcon
} from "@phosphor-icons/react";
import { SCOPE_LABELS, useDiffPrefs } from "@/diff/store";
import { ShortcutKeys, useBinding, type ActionId } from "@/keybindings";
import { cn } from "@/lib/cn";
import { useDocsStore } from "@/editor";
import { FileIcon, iconButtonClassName, Menu, Tooltip } from "@/ui";
import { closeTab } from "./actions";
import { NEW_TABS } from "./kinds";
import { useRightbarStore, type RightTab } from "./store";

// Zeron's chip metrics (crates/ui/src/surface_chrome.rs): fixed width, so
// drag reordering works in whole slots.
const CHIP_WIDTH = 112;
const GAP = 4;
const SLOT = CHIP_WIDTH + GAP;
/** How far the pointer moves before a press becomes a drag. */
const DRAG_THRESHOLD = 4;

type Drag = { id: string; from: number; over: number; dx: number };

/** Where a non-dragged chip slides while `drag` is over the strip: a slot left, right, or none. */
function slideOffset(index: number, { from, over }: Drag) {
    if (from < over && index > from && index <= over) return -SLOT;
    if (from > over && index >= over && index < from) return SLOT;
    return 0;
}

/**
 * The right sidebar's tabs, as in zeron: one chip per tab (icon, title, ✕ on
 * hover), the strip scrolling sideways with faded edges, drag to reorder
 * (the others slide aside), middle-click to close, then "+".
 */
export function TabStrip() {
    const tabs = useRightbarStore((s) => s.tabs);
    const activeId = useRightbarStore((s) => s.activeId);
    const { activate, move } = useRightbarStore.getState();

    const strip = useRef<HTMLDivElement>(null);
    const [fade, setFade] = useState({ left: false, right: false });
    const [drag, setDrag] = useState<Drag | null>(null);
    const press = useRef<{ id: string; from: number; x: number; dragged: boolean } | null>(
        null
    );

    const updateFade = () => {
        const el = strip.current;
        if (!el) return;
        const left = el.scrollLeft > 1;
        const right = el.scrollLeft < el.scrollWidth - el.clientWidth - 1;
        setFade((f) => (f.left === left && f.right === right ? f : { left, right }));
    };

    useLayoutEffect(() => {
        const el = strip.current;
        if (!el) return;
        updateFade();
        const observer = new ResizeObserver(updateFade);
        observer.observe(el);
        return () => observer.disconnect();
    }, [tabs.length]);

    // The shown tab stays in view, e.g. a new one at the end.
    useEffect(() => {
        if (!activeId) return;
        strip.current
            ?.querySelector(`[data-tab="${CSS.escape(activeId)}"]`)
            ?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }, [activeId]);

    const onPointerDown = (event: React.PointerEvent, tab: RightTab, index: number) => {
        if (event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        press.current = { id: tab.id, from: index, x: event.clientX, dragged: false };
    };

    const onPointerMove = (event: React.PointerEvent) => {
        const p = press.current;
        if (!p) return;
        const dx = event.clientX - p.x;
        if (!p.dragged && Math.abs(dx) < DRAG_THRESHOLD) return;
        p.dragged = true;
        // The chip follows the pointer, but not past either end of the strip.
        const clamped = Math.min(Math.max(dx, -p.from * SLOT), (tabs.length - 1 - p.from) * SLOT);
        const over = Math.min(
            Math.max(Math.round(p.from + clamped / SLOT), 0),
            tabs.length - 1
        );
        setDrag({ id: p.id, from: p.from, over, dx: clamped });
    };

    const onPointerUp = () => {
        const p = press.current;
        press.current = null;
        if (!p) return;
        if (p.dragged && drag) move(drag.from, drag.over);
        else activate(p.id);
        setDrag(null);
    };

    return (
        <div data-tauri-drag-region className="flex h-full min-w-0 flex-1 items-center gap-1 px-2">
            {/* Sized to its tabs, so "+" follows the last one; shrinks (and scrolls) once they overflow. */}
            <div data-tauri-drag-region className="relative flex h-full min-w-0 items-center">
                <div
                    ref={strip}
                    data-tauri-drag-region
                    role="tablist"
                    aria-label="Tabs"
                    onScroll={updateFade}
                    onWheel={(event) => {
                        // A mouse wheel scrolls the strip sideways.
                        if (event.deltaX === 0 && strip.current) {
                            strip.current.scrollLeft += event.deltaY;
                        }
                    }}
                    style={{ gap: GAP }}
                    className="hide-scrollbar flex h-full min-w-0 items-center overflow-x-auto"
                >
                    {/* Once a tab's title has shown, the next tab's follows at
                        once, without the fade, until the pointer rests off them. */}
                    <Tooltip.Provider delay={350} timeout={400}>
                        {tabs.map((tab, index) => {
                            const dragged = drag?.id === tab.id;
                            const offset = drag ? (dragged ? drag.dx : slideOffset(index, drag)) : 0;
                            return (
                                <TabChip
                                    key={tab.id}
                                    tab={tab}
                                    active={tab.id === activeId}
                                    dragged={dragged}
                                    offset={offset}
                                    animate={!!drag && !dragged}
                                    dragging={!!drag}
                                    onPointerDown={(event) => onPointerDown(event, tab, index)}
                                    onPointerMove={onPointerMove}
                                    onPointerUp={onPointerUp}
                                    onPointerCancel={() => {
                                        press.current = null;
                                        setDrag(null);
                                    }}
                                    onActivate={() => activate(tab.id)}
                                    onClose={() => void closeTab(tab.id)}
                                />
                            );
                        })}
                    </Tooltip.Provider>
                </div>
                {fade.left && (
                    <div className="pointer-events-none absolute inset-y-0 left-0 w-9 bg-linear-to-r from-dark-850 to-transparent" />
                )}
                {fade.right && (
                    <div className="pointer-events-none absolute inset-y-0 right-0 w-9 bg-linear-to-l from-dark-850 to-transparent" />
                )}
            </div>

            {NEW_TABS.length > 0 && (
                <Menu>
                    <Tooltip>
                        <Tooltip.Trigger
                            render={
                                <Menu.Trigger aria-label="New tab" className={iconButtonClassName}>
                                    <PlusIcon className="size-3.5" />
                                </Menu.Trigger>
                            }
                        />
                        <Tooltip.Content side="bottom">New tab</Tooltip.Content>
                    </Tooltip>
                    <Menu.Content side="bottom" align="end" sideOffset={6} className="w-48 min-w-0">
                        {NEW_TABS.map(({ label, icon: TabIcon, shortcut, open }) => (
                            <Menu.Item key={label} onClick={open}>
                                <TabIcon className="size-3.5 text-dark-200" />
                                {label}
                                {shortcut && <MenuShortcut id={shortcut} />}
                            </Menu.Item>
                        ))}
                    </Menu.Content>
                </Menu>
            )}
        </div>
    );
}

function TabChip({
    tab,
    active,
    dragged,
    offset,
    animate,
    dragging,
    onActivate,
    onClose,
    ...pointer
}: {
    tab: RightTab;
    active: boolean;
    dragged: boolean;
    /** Horizontal shift while a drag is under way. */
    offset: number;
    /** Slides to `offset` rather than jumping (the chips a drag passes over). */
    animate: boolean;
    /** A tab is being dragged: no tooltips meanwhile. */
    dragging: boolean;
    onActivate: () => void;
    onClose: () => void;
    onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
    onPointerMove: (event: React.PointerEvent<HTMLDivElement>) => void;
    onPointerUp: (event: React.PointerEvent<HTMLDivElement>) => void;
    onPointerCancel: (event: React.PointerEvent<HTMLDivElement>) => void;
}) {
    // Unsaved changes: a dot where the ✕ shows on hover, as in zeron.
    const dirty = useDocsStore((s) => !!s.docs[tab.id]?.dirty);
    // The diff tab is titled with what it compares, as zeron's is.
    const scope = useDiffPrefs((s) => s.scope);
    const title = tab.kind === "diff" ? SCOPE_LABELS[scope] : tab.title;
    const chip = (
        <div
            role="tab"
            tabIndex={0}
            data-tab={tab.id}
            aria-selected={active}
            aria-label={title}
            {...pointer}
            onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onActivate();
                }
            }}
            // Middle-click closes, without the browser's autoscroll.
            onMouseDown={(event) => event.button === 1 && event.preventDefault()}
            onAuxClick={(event) => event.button === 1 && onClose()}
            style={{ width: CHIP_WIDTH, transform: offset ? `translateX(${offset}px)` : undefined }}
            className={cn(
                "group/tab relative flex h-6 shrink-0 cursor-pointer items-center gap-[3px] rounded-md px-1 outline-none select-none",
                "focus-visible:ring-1 focus-visible:ring-dark-300",
                animate && "transition-transform duration-150",
                active ? "bg-white/10 text-dark-50" : "text-dark-200 hover:bg-white/[0.06]",
                dragged && "z-10 bg-dark-700 shadow-md"
            )}
        >
            <span className="flex size-[18px] shrink-0 items-center justify-center">
                {tab.kind === "diff" ? (
                    <GitDiffIcon className={cn("size-3.5", !active && "opacity-80")} />
                ) : tab.kind === "terminal" ? (
                    <TerminalWindowIcon className={cn("size-3.5", !active && "opacity-80")} />
                ) : tab.kind === "history" ? (
                    <ClockCounterClockwiseIcon className={cn("size-3.5", !active && "opacity-80")} />
                ) : tab.kind === "commit" ? (
                    <GitCommitIcon className={cn("size-3.5", !active && "opacity-80")} />
                ) : (
                    <FileIcon name={tab.title} className={cn("size-3.5", !active && "opacity-80")} />
                )}
            </span>
            <span className="min-w-0 flex-1 truncate text-[11.5px]">{title}</span>
            <button
                type="button"
                aria-label={dirty ? "Close tab (unsaved changes)" : "Close tab"}
                // Not a drag of the tab, and not its activation.
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                    event.stopPropagation();
                    onClose();
                }}
                className={cn(
                    "relative flex size-[18px] shrink-0 items-center justify-center rounded text-dark-200 outline-none",
                    "hover:bg-white/[0.12] hover:text-dark-50"
                )}
            >
                {dirty && (
                    <span className="absolute size-1.5 rounded-full bg-dark-100 transition-opacity group-hover/tab:opacity-0" />
                )}
                <XIcon className="size-3 opacity-0 transition-opacity group-hover/tab:opacity-100 group-focus-within/tab:opacity-100" />
            </button>
        </div>
    );

    // The file's path (a terminal's folder) on hover, as zeron shows a tab's detail.
    return (
        <Tooltip disabled={dragging}>
            <Tooltip.Trigger delay={350} render={chip} />
            <Tooltip.Content side="bottom">
                {tab.kind === "file"
                    ? tab.path
                    : tab.kind === "diff"
                      ? "Changes in the open chat's folder"
                      : tab.kind === "history"
                        ? "Commits of the open chat's folder"
                        : tab.kind === "commit"
                          ? `${tab.sha.slice(0, 7)} ${tab.subject}`
                          : (tab.cwd ?? "Home folder")}
            </Tooltip.Content>
        </Tooltip>
    );
}

function MenuShortcut({ id }: { id: ActionId }) {
    const binding = useBinding(id);
    return <ShortcutKeys shortcut={binding} variant="plain" className="ml-auto pl-4" />;
}
