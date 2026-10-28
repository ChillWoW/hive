import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { MagnifyingGlassIcon, XIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/cn";
import { iconButtonClassName, Modal } from "@/ui";
import { getSettingsPage, SETTINGS_PAGES } from "./pages";
import { SettingsQueryContext } from "./search";
import { useSettingsStore } from "./store";

/** Open from anywhere with `settings.open()`, Mod+, or the sidebar button. */
export function SettingsModal() {
    const isOpen = useSettingsStore((s) => s.isOpen);
    const setOpen = useSettingsStore((s) => s.setOpen);
    const pageId = useSettingsStore((s) => s.page);
    const setPage = useSettingsStore((s) => s.setPage);
    const [query, setQuery] = useState("");
    const searching = query.trim().length > 0;
    const scroller = useRef<HTMLDivElement>(null);

    const page = getSettingsPage(pageId);
    const Page = page.Component;

    // Reopening lands on the page, not on last time's search.
    useEffect(() => {
        if (!isOpen) setQuery("");
    }, [isOpen]);

    useEffect(() => {
        scroller.current?.scrollTo({ top: 0 });
    }, [pageId, searching]);

    const go = (id: typeof pageId) => {
        setPage(id);
        setQuery("");
    };

    return (
        <Modal
            open={isOpen}
            onOpenChange={setOpen}
            showClose={false}
            className="flex h-[min(38rem,calc(100%-3rem))] w-[calc(100%-3rem)] max-w-4xl overflow-hidden p-0"
            bodyClassName="flex h-full w-full"
        >
            <aside className="flex w-52 shrink-0 flex-col border-r border-dark-600 bg-dark-900">
                <div className="p-2.5">
                    <SearchInput query={query} onChange={setQuery} />
                </div>

                <SettingsNav
                    activeId={searching ? null : pageId}
                    onSelect={go}
                />
            </aside>

            <div className="flex min-w-0 flex-1 flex-col">
                <header className="flex shrink-0 items-center gap-3 px-6 pt-5 pb-4">
                    <h2 className="min-w-0 flex-1 truncate text-base font-semibold text-dark-50">
                        {searching ? "Search results" : page.label}
                    </h2>
                    <Modal.Close
                        aria-label="Close settings"
                        className={cn(iconButtonClassName, "-mr-2")}
                    >
                        <XIcon className="size-4" />
                    </Modal.Close>
                </header>

                <div
                    ref={scroller}
                    className="min-h-0 flex-1 overflow-y-auto px-6 pb-6"
                >
                    <SettingsQueryContext.Provider
                        value={query.trim().toLowerCase()}
                    >
                        {searching ? (
                            <SearchResults onOpenPage={go} />
                        ) : (
                            <div key={page.id} className="flex flex-col gap-7">
                                <Page />
                            </div>
                        )}
                    </SettingsQueryContext.Provider>
                </div>
            </div>
        </Modal>
    );
}

function SearchInput({
    query,
    onChange
}: {
    query: string;
    onChange: (query: string) => void;
}) {
    return (
        <label
            className={cn(
                "flex h-7 items-center gap-1.5 rounded-md border border-dark-600 bg-dark-800 px-2",
                "transition-colors focus-within:border-dark-400 hover:border-dark-500"
            )}
        >
            <MagnifyingGlassIcon className="size-3.5 shrink-0 text-dark-300" />
            <input
                value={query}
                placeholder="Search settings"
                aria-label="Search settings"
                spellCheck={false}
                onChange={(event) => onChange(event.target.value)}
                onKeyDown={(event) => {
                    // First Escape clears the query, the next closes the modal.
                    if (event.key === "Escape" && query) {
                        event.stopPropagation();
                        onChange("");
                    }
                }}
                className="min-w-0 flex-1 bg-transparent text-xs text-dark-50 outline-none placeholder:text-dark-300"
            />
            {query && (
                <button
                    type="button"
                    aria-label="Clear search"
                    onClick={() => onChange("")}
                    className="text-dark-300 transition-colors hover:text-dark-50"
                >
                    <XIcon className="size-3" weight="bold" />
                </button>
            )}
        </label>
    );
}

/** Up/Down (and Home/End) move between pages, like a native tab list. */
function SettingsNav({
    activeId,
    onSelect
}: {
    activeId: string | null;
    onSelect: (id: (typeof SETTINGS_PAGES)[number]["id"]) => void;
}) {
    const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
        const buttons = Array.from(
            event.currentTarget.querySelectorAll<HTMLButtonElement>("button")
        );
        const index = buttons.indexOf(
            document.activeElement as HTMLButtonElement
        );
        if (index < 0) return;
        const next =
            event.key === "ArrowDown"
                ? (index + 1) % buttons.length
                : event.key === "ArrowUp"
                  ? (index - 1 + buttons.length) % buttons.length
                  : event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? buttons.length - 1
                      : null;
        if (next === null) return;
        event.preventDefault();
        buttons[next]!.focus();
        buttons[next]!.click();
    };

    return (
        <nav
            aria-label="Settings pages"
            onKeyDown={onKeyDown}
            className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2"
        >
            {SETTINGS_PAGES.map(({ id, label, icon: Icon }) => {
                const active = activeId === id;
                return (
                    <button
                        key={id}
                        type="button"
                        aria-current={active ? "page" : undefined}
                        onClick={() => onSelect(id)}
                        className={cn(
                            "flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-xs",
                            "transition-colors duration-150",
                            active
                                ? "bg-dark-700 text-dark-50"
                                : "text-dark-200 hover:bg-dark-800 hover:text-dark-50 focus-visible:bg-dark-800"
                        )}
                    >
                        <Icon
                            className={cn(
                                "size-3.5 shrink-0",
                                active ? "text-dark-50" : "text-dark-300"
                            )}
                            weight={active ? "fill" : "regular"}
                        />
                        <span className="min-w-0 truncate">{label}</span>
                    </button>
                );
            })}
        </nav>
    );
}

/** Every page, each filtering its own rows; empty pages and sections hide via `:has()`. */
function SearchResults({
    onOpenPage
}: {
    onOpenPage: (id: (typeof SETTINGS_PAGES)[number]["id"]) => void;
}) {
    return (
        <div className="flex flex-col gap-8 [&:has([data-setting-row])>[data-no-matches]]:hidden">
            {SETTINGS_PAGES.map(({ id, label, icon: Icon, Component }) => (
                <div
                    key={id}
                    className="flex flex-col gap-3 [&:not(:has([data-setting-row]))]:hidden"
                >
                    <button
                        type="button"
                        onClick={() => onOpenPage(id)}
                        className="flex w-fit items-center gap-1.5 text-xs font-medium text-dark-100 transition-colors hover:text-dark-50"
                    >
                        <Icon className="size-3.5 shrink-0 text-dark-300" />
                        {label}
                    </button>
                    <div className="flex flex-col gap-7">
                        <Component />
                    </div>
                </div>
            ))}

            <div
                data-no-matches
                className="flex flex-col items-center gap-2 py-16 text-center"
            >
                <MagnifyingGlassIcon className="size-6 text-dark-400" />
                <p className="text-xs text-dark-300">No settings match</p>
            </div>
        </div>
    );
}
