import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { MagnifyingGlassIcon, XIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/cn";
import { Button, Input, Modal } from "@/ui";
import { getSettingsPage, SETTINGS_CATEGORIES, SETTINGS_PAGES } from "./pages";
import { SettingsQueryContext } from "./search";
import { useSettingsStore, type SettingsPageId } from "./store";

/** Open from anywhere with `settings.open()`, Mod+, or the dock's settings button. */
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

    const go = (id: SettingsPageId) => {
        setPage(id);
        setQuery("");
    };

    return (
        <Modal open={isOpen} onOpenChange={setOpen}>
            <Modal.Content
                size="xl"
                showCloseButton={false}
                className="h-[min(38rem,100%)] flex-row gap-0 overflow-hidden p-0"
            >
                <aside className="flex w-52 shrink-0 flex-col border-r border-border bg-bg">
                    <div className="p-2.5">
                        <SearchInput query={query} onChange={setQuery} />
                    </div>

                    <SettingsNav activeId={searching ? null : pageId} onSelect={go} />
                </aside>

                <div className="flex min-w-0 flex-1 flex-col">
                    <header className="flex shrink-0 items-center gap-3 px-6 pt-5 pb-4">
                        <Modal.Title className="min-w-0 flex-1 truncate">
                            {searching ? "Search results" : page.label}
                        </Modal.Title>
                        <Modal.Close
                            aria-label="Close settings"
                            render={<Button variant="ghost" size="icon-sm" />}
                            className="-mr-2 text-muted hover:text-text"
                        >
                            <XIcon />
                        </Modal.Close>
                    </header>

                    <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
                        <SettingsQueryContext.Provider value={query.trim().toLowerCase()}>
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
            </Modal.Content>
        </Modal>
    );
}

function SearchInput({ query, onChange }: { query: string; onChange: (query: string) => void }) {
    return (
        <Input.Group size="xs">
            <Input.Addon>
                <MagnifyingGlassIcon />
            </Input.Addon>
            <Input
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
            />
            {query && (
                <Input.Addon>
                    <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label="Clear search"
                        onClick={() => onChange("")}
                        className="size-5 text-muted hover:text-text"
                    >
                        <XIcon className="size-3" weight="bold" />
                    </Button>
                </Input.Addon>
            )}
        </Input.Group>
    );
}

/** Up/Down (and Home/End) move between pages, like a native tab list. */
function SettingsNav({
    activeId,
    onSelect
}: {
    activeId: SettingsPageId | null;
    onSelect: (id: SettingsPageId) => void;
}) {
    const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
        const buttons = Array.from(
            event.currentTarget.querySelectorAll<HTMLButtonElement>("button")
        );
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
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
            className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-2 pb-2"
        >
            {SETTINGS_CATEGORIES.map((category) => (
                <div
                    key={category.id}
                    role="group"
                    aria-labelledby={`settings-category-${category.id}`}
                    className="flex flex-col gap-0.5"
                >
                    <div
                        id={`settings-category-${category.id}`}
                        className="px-2 pb-1 text-[11px] font-medium text-muted select-none"
                    >
                        {category.label}
                    </div>
                    {category.pages.map(({ id, label, icon: Icon }) => {
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
                                        ? "bg-hover text-text"
                                        : "text-muted hover:bg-raised hover:text-text focus-visible:bg-raised"
                                )}
                            >
                                <Icon
                                    className={cn(
                                        "size-3.5 shrink-0",
                                        active ? "text-text" : "text-muted"
                                    )}
                                    weight={active ? "fill" : "regular"}
                                />
                                <span className="min-w-0 truncate">{label}</span>
                            </button>
                        );
                    })}
                </div>
            ))}
        </nav>
    );
}

/** Every page, each filtering its own rows; empty pages and sections hide via `:has()`. */
function SearchResults({ onOpenPage }: { onOpenPage: (id: SettingsPageId) => void }) {
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
                        className="flex w-fit items-center gap-1.5 text-xs font-medium text-muted transition-colors hover:text-text"
                    >
                        <Icon className="size-3.5 shrink-0" />
                        {label}
                    </button>
                    <div className="flex flex-col gap-7">
                        <Component />
                    </div>
                </div>
            ))}

            <div data-no-matches className="flex flex-col items-center gap-2 py-16 text-center">
                <MagnifyingGlassIcon className="size-6 text-muted" />
                <p className="text-xs text-muted">No settings match</p>
            </div>
        </div>
    );
}
