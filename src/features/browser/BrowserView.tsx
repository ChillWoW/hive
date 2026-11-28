import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
    ArrowClockwiseIcon,
    ArrowLeftIcon,
    ArrowRightIcon,
    ArrowSquareOutIcon,
    CameraIcon,
    CodeIcon,
    CopyIcon,
    CursorClickIcon,
    DevicesIcon,
    DotsThreeIcon,
    GlobeIcon,
    XIcon
} from "@phosphor-icons/react";
import { cn } from "@/lib/cn";
import { IconButton, iconButtonClassName, Menu, Tooltip } from "@/ui";
import { attachScreenshot, navigate, pickElement } from "./actions";
import { browserApi, type BrowserTab, type Viewport } from "./api";
import { openExternally } from "./open";
import { trackFrame, type Still } from "./placement";
import { isBlank, useBrowserStore, useBrowserTab } from "./store";

/** The page sizes on offer; "fit" is the panel's own. */
const SIZES: { id: string; label: string; viewport: Viewport | null }[] = [
    { id: "fit", label: "Fit the panel", viewport: null },
    { id: "phone", label: "Phone", viewport: { width: 390, height: 844 } },
    { id: "tablet", label: "Tablet", viewport: { width: 820, height: 1180 } },
    { id: "desktop", label: "Desktop", viewport: { width: 1440, height: 900 } }
];

const sizeId = (viewport: Viewport | null) =>
    SIZES.find((s) => s.viewport?.width === viewport?.width && s.viewport?.height === viewport?.height)?.id ?? "custom";

/**
 * A browser tab: its toolbar, and the frame its page shows in. The page is
 * a native webview kept over the frame (`placement.ts`), so nothing drawn
 * here can sit on top of it: the frame holds only the still picture that
 * stands in while the webview is away.
 */
export function BrowserView({ id }: { id: string }) {
    const tab = useBrowserTab(id);
    const frame = useRef<HTMLDivElement>(null);
    const [still, setStill] = useState<Still | null>(null);
    const viewport = tab?.viewport ?? null;
    const latestViewport = useRef(viewport);
    useLayoutEffect(() => {
        latestViewport.current = viewport;
    });

    const driven = useLinger(tab?.agent ?? null, 1500) !== null;
    // A blank tab has no page to show: the frame says so itself, and the webview stays away.
    const blank = !tab || isBlank(tab.url);

    useEffect(() => {
        if (!frame.current || blank) return;
        return trackFrame(id, frame.current, () => latestViewport.current, setStill);
    }, [id, blank]);

    return (
        <div tabIndex={-1} className="flex min-h-0 flex-1 flex-col outline-none">
            {tab && <Toolbar tab={tab} />}
            {/* Inset, so the panel's resize edge and the box's rounded corners stay the page's. */}
            <div className="flex min-h-0 flex-1 px-1.5 pt-0.5 pb-1.5">
                <div
                    ref={frame}
                    className={cn(
                        "relative min-h-0 flex-1 overflow-hidden rounded-sm bg-surface",
                        // An agent is acting on the page: its edge glows.
                        driven && "animate-agent-glow motion-reduce:animate-none motion-reduce:ring-2 motion-reduce:ring-info"
                    )}
                >
                    {blank && (
                        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center">
                            <GlobeIcon className="size-7 text-muted/60" />
                            <div className="text-[13px] font-medium text-text/80">New tab</div>
                            <div className="max-w-64 text-xs text-muted">
                                Enter an address or a search above, or ask an agent to open a page here
                            </div>
                        </div>
                    )}
                    {!blank && still?.url && (
                        <img
                            src={still.url}
                            alt=""
                            draggable={false}
                            style={{ left: still.left, top: still.top, width: still.width, height: still.height }}
                            className="absolute max-w-none select-none"
                        />
                    )}
                </div>
            </div>
        </div>
    );
}

function Toolbar({ tab }: { tab: BrowserTab }) {
    const picking = useBrowserStore((s) => s.picking === tab.id);
    return (
        <div className="relative flex h-9 shrink-0 items-center gap-0.5 px-1.5">
            <IconButton label="Back" side="top" disabled={!tab.canGoBack} onClick={() => void browserApi.go(tab.id, "back")}>
                <ArrowLeftIcon className="size-3.5" />
            </IconButton>
            <IconButton
                label="Forward"
                side="top"
                disabled={!tab.canGoForward}
                onClick={() => void browserApi.go(tab.id, "forward")}
            >
                <ArrowRightIcon className="size-3.5" />
            </IconButton>
            {tab.loading ? (
                <IconButton label="Stop" side="top" onClick={() => void browserApi.go(tab.id, "stop")}>
                    <XIcon className="size-3.5" />
                </IconButton>
            ) : (
                <IconButton label="Reload" side="top" onClick={() => void browserApi.go(tab.id, "reload")}>
                    <ArrowClockwiseIcon className="size-3.5" />
                </IconButton>
            )}
            {picking ? (
                <div className="mx-1 flex h-6 min-w-0 flex-1 items-center rounded-md bg-raised px-2 text-xs text-muted">
                    <span className="truncate">Click an element in the page, or press Esc there</span>
                </div>
            ) : (
                // Keyed by the page, so a new one drops what was half-typed for the last.
                <Address key={tab.url} tab={tab} />
            )}
            <IconButton
                label={picking ? "Cancel picking" : "Pick an element"}
                tooltip={picking ? "Cancel picking" : "Pick an element for the prompt"}
                side="top"
                aria-pressed={picking}
                onClick={() => void pickElement(tab.id)}
                className={cn(picking && "bg-hover text-text")}
            >
                <CursorClickIcon className="size-3.5" />
            </IconButton>
            <IconButton
                label="Attach a screenshot"
                tooltip="Attach a screenshot to the prompt"
                side="top"
                onClick={() => void attachScreenshot(tab.id)}
            >
                <CameraIcon className="size-3.5" />
            </IconButton>
            <SizeMenu tab={tab} />
            <MoreMenu tab={tab} />
            {tab.loading && <div className="absolute inset-x-0 bottom-0 h-px animate-pulse bg-info" />}
        </div>
    );
}

/** The address field: the page's URL until typed in; Enter loads a URL, a host or a search. */
function Address({ tab }: { tab: BrowserTab }) {
    const [draft, setDraft] = useState<string | null>(null);
    const blank = isBlank(tab.url);
    const input = useRef<HTMLInputElement>(null);
    // A new, blank tab starts in its address field. Again a moment later:
    // the menu it was opened from takes the focus back as it closes.
    useEffect(() => {
        if (!blank) return;
        input.current?.focus();
        const timer = window.setTimeout(() => {
            // Unless the user has gone on to type somewhere else.
            const active = document.activeElement;
            const elsewhere = active instanceof HTMLElement && active.matches("input, textarea, [contenteditable='true']");
            if (!elsewhere) input.current?.focus();
        }, 250);
        return () => window.clearTimeout(timer);
    }, [blank]);
    return (
        <form
            className="mx-1 flex h-6 min-w-0 flex-1 items-center rounded-md bg-raised px-2 focus-within:ring-1 focus-within:ring-muted/50"
            onSubmit={(event) => {
                event.preventDefault();
                const text = (draft ?? tab.url).trim();
                if (text) navigate(tab.id, text);
                setDraft(null);
                (document.activeElement as HTMLElement | null)?.blur();
            }}
        >
            <input
                ref={input}
                aria-label="Address"
                value={draft ?? (blank ? "" : tab.url)}
                placeholder="Search or enter an address"
                spellCheck={false}
                autoComplete="off"
                onChange={(event) => setDraft(event.target.value)}
                onFocus={(event) => event.target.select()}
                onBlur={() => setDraft(null)}
                onKeyDown={(event) => {
                    if (event.key !== "Escape") return;
                    setDraft(null);
                    event.currentTarget.blur();
                }}
                className="h-full min-w-0 flex-1 bg-transparent text-xs text-text outline-none placeholder:text-muted"
            />
        </form>
    );
}

/** `value`, kept for `ms` after it goes null, so a mark that flickers on and off reads as on. */
function useLinger<T>(value: T | null, ms: number): T | null {
    const [held, setHeld] = useState(value);
    if (value !== null && value !== held) setHeld(value);
    useEffect(() => {
        if (value !== null) return;
        const timer = window.setTimeout(() => setHeld(null), ms);
        return () => window.clearTimeout(timer);
    }, [value, ms]);
    return value ?? held;
}

/** The page size the tab is shown at. */
function SizeMenu({ tab }: { tab: BrowserTab }) {
    const current = sizeId(tab.viewport);
    return (
        <Menu>
            <Tooltip>
                <Tooltip.Trigger
                    render={
                        <Menu.Trigger
                            aria-label="Page size"
                            className={cn(iconButtonClassName, "shrink-0", tab.viewport && "w-auto gap-1 px-1.5 text-[11px] text-text")}
                        />
                    }
                >
                    <DevicesIcon className="size-3.5" />
                    {tab.viewport && `${tab.viewport.width}×${tab.viewport.height}`}
                </Tooltip.Trigger>
                <Tooltip.Content side="top">Page size</Tooltip.Content>
            </Tooltip>
            <Menu.Content align="end" sideOffset={6} className="min-w-48 whitespace-nowrap">
                <Menu.RadioGroup
                    value={current}
                    onValueChange={(value) => {
                        const size = SIZES.find((s) => s.id === value);
                        if (size) void browserApi.setViewport(tab.id, size.viewport);
                    }}
                >
                    {SIZES.map((size) => (
                        <Menu.RadioItem key={size.id} value={size.id} closeOnClick>
                            {size.label}
                            {size.viewport && (
                                <Menu.Shortcut>
                                    {size.viewport.width}×{size.viewport.height}
                                </Menu.Shortcut>
                            )}
                        </Menu.RadioItem>
                    ))}
                    {current === "custom" && tab.viewport && (
                        <Menu.RadioItem value="custom" closeOnClick>
                            Custom
                            <Menu.Shortcut>
                                {tab.viewport.width}×{tab.viewport.height}
                            </Menu.Shortcut>
                        </Menu.RadioItem>
                    )}
                </Menu.RadioGroup>
            </Menu.Content>
        </Menu>
    );
}

function MoreMenu({ tab }: { tab: BrowserTab }) {
    const web = /^https?:/.test(tab.url);
    return (
        <Menu>
            <Tooltip>
                <Tooltip.Trigger render={<Menu.Trigger aria-label="More" className={cn(iconButtonClassName, "shrink-0")} />}>
                    <DotsThreeIcon className="size-3.5" weight="bold" />
                </Tooltip.Trigger>
                <Tooltip.Content side="top">More</Tooltip.Content>
            </Tooltip>
            <Menu.Content align="end" sideOffset={6} className="min-w-52 whitespace-nowrap">
                <Menu.Item disabled={!web} onClick={() => openExternally(tab.url)}>
                    <ArrowSquareOutIcon className="size-3.5 text-muted" />
                    Open in your browser
                </Menu.Item>
                <Menu.Item disabled={isBlank(tab.url)} onClick={() => void navigator.clipboard.writeText(tab.url)}>
                    <CopyIcon className="size-3.5 text-muted" />
                    Copy address
                </Menu.Item>
                <Menu.Separator />
                <Menu.Item onClick={() => void browserApi.devtools(tab.id)}>
                    <CodeIcon className="size-3.5 text-muted" />
                    Open DevTools
                </Menu.Item>
            </Menu.Content>
        </Menu>
    );
}

/** A browser tab's icon in the strip: its site's, else a globe; a ring turns around it while an agent acts on it. */
export function BrowserTabIcon({ id, className }: { id: string; className?: string }) {
    const favicon = useBrowserStore((s) => s.tabs[id]?.favicon ?? null);
    const agent = useLinger(
        useBrowserStore((s) => s.tabs[id]?.agent ?? null),
        1500
    );
    const [failed, setFailed] = useState<string | null>(null);
    return (
        <span className={cn("relative inline-flex size-3.5 shrink-0", className)}>
            {favicon && failed !== favicon ? (
                <img
                    src={favicon}
                    alt=""
                    draggable={false}
                    referrerPolicy="no-referrer"
                    onError={() => setFailed(favicon)}
                    className={cn("size-3.5 object-contain select-none", agent !== null ? "rounded-full" : "rounded-[3px]")}
                />
            ) : (
                <GlobeIcon className="size-3.5 text-muted" />
            )}
            {agent !== null && (
                <span className="absolute -inset-[3px] animate-spin rounded-full border-[1.5px] border-transparent border-t-info border-r-info motion-reduce:animate-none" />
            )}
        </span>
    );
}
