import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { GitDiffIcon, PlusIcon, TerminalWindowIcon, XIcon } from "@phosphor-icons/react";
import { useRevealActive, useSidewaysWheel, useTabDrag } from "@/features/tabs";
import { openTerminal } from "@/features/terminal";
import { cn } from "@/lib/cn";
import { ContextMenu, FileIcon, IconButton, Menu, Tooltip } from "@/ui";
import { panelTabs, usePanelTabsStore, type PanelTab } from "./store";

/**
 * The tabs panel's head: its tabs, editor-like, then + for a new terminal.
 * A press shows one, dragging reorders, middle-click or × closes, right-click
 * for more; past its room the strip scrolls (the wheel scrolls it sideways).
 */
export function PanelTabStrip() {
    const list = usePanelTabsStore((s) => s.tabs);
    const active = usePanelTabsStore((s) => s.activeId);
    const scroller = useRef<HTMLDivElement>(null);
    useRevealActive(scroller, `${active}:${list.length}`);
    useSidewaysWheel(scroller);
    const drag = useTabDrag(scroller, panelTabs.move);

    return (
        <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-1.5">
            <div
                ref={scroller}
                role="tablist"
                aria-label="Open tabs"
                className="hide-scrollbar flex h-full min-w-0 items-center gap-0.5 overflow-x-auto"
            >
                {list.map((tab, index) => (
                    <PanelTabItem
                        key={tab.id}
                        tab={tab}
                        active={tab.id === active}
                        onPointerDown={(event) => drag(event, index)}
                    />
                ))}
            </div>
            <IconButton
                label="New terminal"
                shortcut="newTerminal"
                onClick={() => openTerminal()}
                className="shrink-0"
            >
                <PlusIcon className="size-3.5" />
            </IconButton>
        </div>
    );
}

/** A tab kind's glyph; a file's is its file-type icon. */
export function PanelTabIcon({ tab, className }: { tab: Pick<PanelTab, "kind" | "title">; className?: string }) {
    if (tab.kind === "file") return <FileIcon name={tab.title} className={cn("size-3.5", className)} />;
    const Glyph = tab.kind === "diff" ? GitDiffIcon : TerminalWindowIcon;
    return <Glyph className={cn("size-3.5 shrink-0 text-muted", className)} />;
}

function PanelTabItem({
    tab,
    active,
    onPointerDown
}: {
    tab: PanelTab;
    active: boolean;
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
}) {
    const [menuOpen, setMenuOpen] = useState(false);

    return (
        <Tooltip disabled={!tab.detail || menuOpen} disableHoverablePopup>
            <ContextMenu onOpenChange={setMenuOpen}>
                <ContextMenu.Trigger
                    render={<Tooltip.Trigger delay={600} closeOnClick render={<div />} />}
                    role="tab"
                    aria-selected={active}
                    data-tab-active={active || undefined}
                    tabIndex={active ? 0 : -1}
                    onPointerDown={(event) => {
                        if (event.button !== 0) return;
                        // A press on × closes instead.
                        if ((event.target as Element).closest("[data-tab-close]")) return;
                        panelTabs.select(tab.id);
                        onPointerDown(event);
                    }}
                    onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") panelTabs.select(tab.id);
                    }}
                    onAuxClick={(event) => {
                        if (event.button === 1) panelTabs.close(tab.id);
                    }}
                    // Middle-click would otherwise start autoscroll.
                    onMouseDown={(event) => event.button === 1 && event.preventDefault()}
                    className={cn(
                        "group/tab relative flex h-7 w-40 min-w-20 shrink cursor-default items-center gap-1.5",
                        "rounded-md pr-1 pl-2 text-xs outline-none transition-colors duration-100",
                        "focus-visible:ring-1 focus-visible:ring-muted/50",
                        active
                            ? "bg-hover text-text"
                            : "text-text/70 hover:bg-raised hover:text-text data-[popup-open]:bg-raised"
                    )}
                >
                    <PanelTabIcon tab={tab} />
                    <span className="min-w-0 flex-1 truncate">{tab.title}</span>
                    <CloseButton tab={tab} active={active} />
                </ContextMenu.Trigger>
                <ContextMenu.Content className="w-44 min-w-0">
                    <TabMenuItems tab={tab} />
                </ContextMenu.Content>
            </ContextMenu>
            {tab.detail && (
                <Tooltip.Content side="bottom" sideOffset={6}>
                    {tab.detail}
                </Tooltip.Content>
            )}
        </Tooltip>
    );
}

/** ×, shown on the active or hovered tab; on a dirty one a dot stands in until hovered. */
function CloseButton({ tab, active }: { tab: PanelTab; active: boolean }) {
    return (
        <button
            type="button"
            data-tab-close
            aria-label={`Close ${tab.title}`}
            tabIndex={-1}
            onClick={() => panelTabs.close(tab.id)}
            className={cn(
                "relative inline-flex size-5 shrink-0 items-center justify-center rounded-sm text-muted outline-none",
                "transition-[color,background-color,opacity] duration-100 hover:bg-border hover:text-text",
                active || tab.dirty ? "opacity-100" : "opacity-0 group-hover/tab:opacity-100"
            )}
        >
            <XIcon className={cn("size-3", tab.dirty && "opacity-0 group-hover/tab:opacity-100")} />
            {tab.dirty && (
                <span
                    aria-hidden
                    className="absolute size-2 rounded-full bg-text/70 group-hover/tab:opacity-0"
                />
            )}
        </button>
    );
}

function TabMenuItems({ tab }: { tab: PanelTab }) {
    const list = usePanelTabsStore((s) => s.tabs);
    const last = list.at(-1)?.id === tab.id;
    return (
        <>
            <Menu.Item onClick={() => panelTabs.close(tab.id)}>Close</Menu.Item>
            <Menu.Item disabled={list.length < 2} onClick={() => panelTabs.closeOthers(tab.id)}>
                Close others
            </Menu.Item>
            <Menu.Item disabled={last} onClick={() => panelTabs.closeToRight(tab.id)}>
                Close to the right
            </Menu.Item>
            <Menu.Separator />
            <Menu.Item onClick={panelTabs.closeAll}>Close all</Menu.Item>
        </>
    );
}
