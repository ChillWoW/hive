import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { CaretDownIcon, NotePencilIcon, PlusIcon, XIcon } from "@phosphor-icons/react";
import { useAsking, useChatsStore, useWorking } from "@/features/chats";
import type { HarnessId } from "@/proto";
import { HarnessMark } from "@/features/models";
import { ChatCard } from "@/features/sidebar/ChatCard";
import { CARD_DWELL, UNTITLED } from "@/features/sidebar/ChatRow";
import { useShortcut } from "@/keybindings";
import { cn } from "@/lib/cn";
import { ContextMenu, IconButton, iconButtonClassName, Menu, Tooltip } from "@/ui";
import { isLoneNewTab, tabs, useTabsStore, type Tab } from "./store";
import { useRevealActive, useSidewaysWheel, useTabDrag } from "./strip";

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

    useRevealActive(scroller, `${active}:${list.length}:${overflowing}`);
    useSidewaysWheel(scroller);

    const drag = useTabDrag(scroller, tabs.move);

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
    const asking = useAsking(tab);
    const title = tab === null ? UNTITLED : chat?.title?.trim() || UNTITLED;
    return (
        <Menu.Item onClick={() => useChatsStore.getState().select(tab)}>
            <TabIcon tab={tab} harness={chat?.config.harness} />
            <TabTitle title={title} working={working && !asking} />
        </Menu.Item>
    );
}

/** A tab's title; light sweeps across it, dimmed, while its chat works (as the sidebar's rows). */
function TabTitle({ title, working }: { title: string; working: boolean }) {
    return (
        <span className="flex min-w-0 flex-1">
            {/* On a span the text's width, so the band crosses the title, not the tab. */}
            <span className={cn("min-w-0 truncate", working && "shimmer text-muted")}>{title}</span>
        </span>
    );
}

/** A tab's mark: a pulsing dot while it waits on the user, the new-chat pencil, or the provider's mark. */
function TabIcon({ tab, harness }: { tab: Tab; harness: HarnessId | undefined }) {
    const asking = useAsking(tab);
    return (
        <span className="flex w-3.5 shrink-0 justify-center">
            {asking ? (
                <span role="img" aria-label="Needs your answer" className="size-1.5 animate-pulse rounded-full bg-warning" />
            ) : tab === null ? (
                <NotePencilIcon className="size-3.5" />
            ) : (
                <HarnessMark harness={harness} className="size-3" />
            )}
        </span>
    );
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
    const asking = useAsking(tab);
    const [menuOpen, setMenuOpen] = useState(false);
    const title = tab === null ? UNTITLED : chat?.title?.trim() || UNTITLED;

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
                    <TabIcon tab={tab} harness={chat?.config.harness} />
                    <TabTitle title={title} working={working && !asking} />
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
                    <ChatCard chat={chat} title={title} working={working} asking={asking} />
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
