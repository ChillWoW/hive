import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { CaretDownIcon, NotePencilIcon, PlusIcon, XIcon } from "@phosphor-icons/react";
import { useChatsStore, useWorking } from "@/features/chats";
import { ClaudeMark } from "@/features/models";
import { ChatCard } from "@/features/sidebar/ChatCard";
import { CARD_DWELL, UNTITLED } from "@/features/sidebar/ChatRow";
import { useShortcut } from "@/keybindings";
import { cn } from "@/lib/cn";
import { ContextMenu, DotMatrixSpinner, IconButton, iconButtonClassName, Menu, Tooltip } from "@/ui";
import { isLoneNewTab, tabs, useTabsStore, type Tab } from "./store";

/** How far the pointer moves before a press on a tab becomes a drag, in px. */
const DRAG_SLOP = 4;

/**
 * The open chats as tabs across the top bar, browser-like: a press shows one,
 * dragging reorders, middle-click or × closes, right-click for more. Past
 * its room the strip scrolls (the wheel scrolls it sideways) and a menu after
 * it lists the tabs out of view; then "+" opens the new-chat view and an
 * empty strip still drags the window.
 */
export function TabStrip() {
    const list = useTabsStore((s) => s.tabs);
    const active = useChatsStore((s) => s.activeChatId);
    const scroller = useRef<HTMLDivElement>(null);
    const lone = isLoneNewTab(list);
    const hidden = useHiddenTabs(scroller, list);
    // The "more tabs" button takes room from the strip as it comes and goes.
    const overflowing = hidden.length > 0;

    useShortcut("newTab", tabs.openNew);
    useShortcut("closeTab", () => {
        if (lone) return false;
        tabs.close(active);
    });
    useShortcut("nextTab", () => tabs.cycle(1));
    useShortcut("previousTab", () => tabs.cycle(-1));
    useShortcut("goToTab1", () => tabs.show(0));
    useShortcut("goToTab2", () => tabs.show(1));
    useShortcut("goToTab3", () => tabs.show(2));
    useShortcut("goToTab4", () => tabs.show(3));
    useShortcut("goToTab5", () => tabs.show(4));
    useShortcut("goToTab6", () => tabs.show(5));
    useShortcut("goToTab7", () => tabs.show(6));
    useShortcut("goToTab8", () => tabs.show(7));
    useShortcut("goToLastTab", () => tabs.show(-1));

    // The shown tab scrolls into view, and stays there as the strip narrows.
    useEffect(() => {
        const root = scroller.current;
        if (!root) return;
        const reveal = () =>
            root
                .querySelector<HTMLElement>("[data-tab-active]")
                ?.scrollIntoView({ block: "nearest", inline: "nearest" });
        reveal();
        const observer = new ResizeObserver(reveal);
        // The tabs too: they can shrink while the strip keeps its width.
        for (const el of [root, ...Array.from(root.children)]) observer.observe(el);
        return () => observer.disconnect();
    }, [active, list.length, overflowing]);

    // The wheel scrolls the strip sideways; non-passive so the page doesn't scroll too.
    useEffect(() => {
        const el = scroller.current;
        if (!el) return;
        const onWheel = (event: WheelEvent) => {
            if (el.scrollWidth <= el.clientWidth || event.deltaX !== 0) return;
            event.preventDefault();
            el.scrollLeft += event.deltaY;
        };
        el.addEventListener("wheel", onWheel, { passive: false });
        return () => el.removeEventListener("wheel", onWheel);
    }, []);

    const drag = useTabDrag(scroller);

    return (
        <div data-tauri-drag-region className="flex h-full min-w-0 flex-1 items-center gap-1">
            <div
                ref={scroller}
                role="tablist"
                aria-label="Open chats"
                className="hide-scrollbar flex h-full min-w-0 items-center gap-0.5 overflow-x-auto"
            >
                {list.map((tab, index) => (
                    <TabItem
                        key={keyOf(tab)}
                        tab={tab}
                        active={tab === active}
                        closable={!lone}
                        onPointerDown={(event) => drag(event, index)}
                    />
                ))}
            </div>
            {overflowing && <OverflowMenu hidden={hidden} />}
            <IconButton label="New chat" shortcut="newTab" onClick={tabs.openNew}>
                <PlusIcon className="size-3.5" />
            </IconButton>
            {/* An empty strip to grab the window by. */}
            <div data-tauri-drag-region className="h-full min-w-10 flex-1" />
        </div>
    );
}

/** A tab's `data-tab-key`: its chat id, or "new". */
const keyOf = (tab: Tab) => tab ?? "new";

/** The tabs not wholly in the strip's view, in strip order. */
function useHiddenTabs(scroller: RefObject<HTMLDivElement | null>, list: Tab[]): Tab[] {
    const [hidden, setHidden] = useState<Tab[]>([]);
    useEffect(() => {
        const root = scroller.current;
        if (!root) return;
        const out = new Set<string>();
        const observer = new IntersectionObserver(
            (entries) => {
                for (const entry of entries) {
                    const key = (entry.target as HTMLElement).dataset.tabKey ?? "";
                    if (entry.intersectionRatio < 0.99) out.add(key);
                    else out.delete(key);
                }
                setHidden(list.filter((t) => out.has(keyOf(t))));
            },
            { root, threshold: [0, 0.99] }
        );
        for (const el of Array.from(root.querySelectorAll("[data-tab-key]"))) observer.observe(el);
        return () => observer.disconnect();
    }, [scroller, list]);
    return hidden;
}

/** "⌄ n": the tabs scrolled out of view; picking one shows it (and scrolls it in). */
function OverflowMenu({ hidden }: { hidden: Tab[] }) {
    return (
        <Menu>
            <Tooltip>
                <Tooltip.Trigger
                    render={
                        <Menu.Trigger
                            aria-label={`${hidden.length} more tabs`}
                            className={cn(iconButtonClassName, "w-auto gap-0.5 px-1 text-[11px] tabular-nums")}
                        />
                    }
                >
                    <CaretDownIcon className="size-3" weight="bold" />
                    {hidden.length}
                </Tooltip.Trigger>
                <Tooltip.Content side="bottom">More tabs</Tooltip.Content>
            </Tooltip>
            <Menu.Content align="end" sideOffset={6} className="max-h-96 w-64 min-w-0 overflow-y-auto">
                {hidden.map((tab) => (
                    <OverflowItem key={keyOf(tab)} tab={tab} />
                ))}
            </Menu.Content>
        </Menu>
    );
}

function OverflowItem({ tab }: { tab: Tab }) {
    const chat = useChatsStore((s) => (tab ? s.chats.find((c) => c.id === tab) : undefined));
    const working = useWorking(tab);
    const title = tab === null ? UNTITLED : chat?.title?.trim() || UNTITLED;
    return (
        <Menu.Item onClick={() => useChatsStore.getState().select(tab)}>
            <TabIcon tab={tab} working={working} />
            <span className={cn("min-w-0 flex-1 truncate", (tab === null || !chat?.title?.trim()) && "text-muted")}>
                {title}
            </span>
        </Menu.Item>
    );
}

/** A tab's mark: working dots, the new-chat pencil, or the provider's mark. */
function TabIcon({ tab, working }: { tab: Tab; working: boolean }) {
    return (
        <span className="flex w-3.5 shrink-0 justify-center">
            {working ? (
                <DotMatrixSpinner label="Working" className="size-2.5 text-text/85" />
            ) : tab === null ? (
                <NotePencilIcon className="size-3.5 text-muted" />
            ) : (
                <ClaudeMark className="size-3" />
            )}
        </span>
    );
}

/**
 * Press-and-drag reordering: past `DRAG_SLOP` the pressed tab moves to
 * whichever slot the pointer is over, live. Pointer events, since the
 * webview's HTML drag and drop is the window's file drop on Windows.
 */
function useTabDrag(scroller: RefObject<HTMLDivElement | null>) {
    return (event: ReactPointerEvent<HTMLElement>, index: number) => {
        if (event.button !== 0) return;
        const target = event.currentTarget;
        const startX = event.clientX;
        let from = index;
        let dragging = false;

        const onMove = (move: PointerEvent) => {
            if (!dragging && Math.abs(move.clientX - startX) < DRAG_SLOP) return;
            if (!dragging) {
                dragging = true;
                target.setPointerCapture(move.pointerId);
            }
            const slots = Array.from(scroller.current?.querySelectorAll<HTMLElement>("[role=tab]") ?? []);
            const to = slots.findIndex((slot) => {
                const rect = slot.getBoundingClientRect();
                return move.clientX >= rect.left && move.clientX < rect.right;
            });
            if (to >= 0 && to !== from) {
                tabs.move(from, to);
                from = to;
            }
        };
        const onUp = () => {
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
            window.removeEventListener("pointercancel", onUp);
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
        window.addEventListener("pointercancel", onUp);
    };
}

function TabItem({
    tab,
    active,
    closable,
    onPointerDown
}: {
    tab: Tab;
    active: boolean;
    closable: boolean;
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
}) {
    const chat = useChatsStore((s) => (tab ? s.chats.find((c) => c.id === tab) : undefined));
    const working = useWorking(tab);
    const [menuOpen, setMenuOpen] = useState(false);
    const title = tab === null ? UNTITLED : chat?.title?.trim() || UNTITLED;
    const untitled = tab === null || !chat?.title?.trim();

    return (
        <Tooltip disabled={!chat || menuOpen} disableHoverablePopup>
            <ContextMenu onOpenChange={setMenuOpen}>
                <ContextMenu.Trigger
                    render={<Tooltip.Trigger delay={CARD_DWELL} closeOnClick render={<div />} />}
                    role="tab"
                    aria-selected={active}
                    data-tab-active={active || undefined}
                    data-tab-key={keyOf(tab)}
                    tabIndex={active ? 0 : -1}
                    onPointerDown={(event) => {
                        if (event.button !== 0) return;
                        // A press on × closes instead.
                        if ((event.target as Element).closest("[data-tab-close]")) return;
                        useChatsStore.getState().select(tab);
                        onPointerDown(event);
                    }}
                    onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") useChatsStore.getState().select(tab);
                    }}
                    onAuxClick={(event) => {
                        if (event.button === 1 && closable) tabs.close(tab);
                    }}
                    // Middle-click would otherwise start autoscroll.
                    onMouseDown={(event) => event.button === 1 && event.preventDefault()}
                    className={cn(
                        "group/tab relative flex h-7 w-48 min-w-24 shrink cursor-default items-center gap-2",
                        "rounded-md pr-1 pl-2 text-xs outline-none transition-colors duration-100",
                        "focus-visible:ring-1 focus-visible:ring-muted/50",
                        active
                            ? "bg-hover text-text"
                            : "text-text/70 hover:bg-raised hover:text-text data-[popup-open]:bg-raised"
                    )}
                >
                    <TabIcon tab={tab} working={working} />
                    <span className={cn("min-w-0 flex-1 truncate", untitled && "text-muted")}>{title}</span>
                    {closable && (
                        <button
                            type="button"
                            data-tab-close
                            aria-label={`Close ${title}`}
                            tabIndex={-1}
                            onClick={() => tabs.close(tab)}
                            className={cn(
                                "inline-flex size-5 shrink-0 items-center justify-center rounded-sm text-muted outline-none",
                                "transition-[color,background-color,opacity] duration-100 hover:bg-border hover:text-text",
                                active ? "opacity-100" : "opacity-0 group-hover/tab:opacity-100"
                            )}
                        >
                            <XIcon className="size-3" />
                        </button>
                    )}
                </ContextMenu.Trigger>
                <ContextMenu.Content className="w-44 min-w-0">
                    <TabMenuItems tab={tab} closable={closable} />
                </ContextMenu.Content>
            </ContextMenu>
            {chat && (
                <Tooltip.Content
                    side="bottom"
                    sideOffset={8}
                    collisionPadding={12}
                    className="w-[284px] max-w-none p-3 font-normal"
                >
                    <ChatCard chat={chat} title={title} working={working} />
                </Tooltip.Content>
            )}
        </Tooltip>
    );
}

function TabMenuItems({ tab, closable }: { tab: Tab; closable: boolean }) {
    const list = useTabsStore((s) => s.tabs);
    const last = list.indexOf(tab) === list.length - 1;
    return (
        <>
            <Menu.Item disabled={!closable} onClick={() => tabs.close(tab)}>
                Close
            </Menu.Item>
            <Menu.Item disabled={list.length < 2} onClick={() => tabs.closeOthers(tab)}>
                Close others
            </Menu.Item>
            <Menu.Item disabled={last} onClick={() => tabs.closeToRight(tab)}>
                Close to the right
            </Menu.Item>
        </>
    );
}
