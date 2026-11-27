import { useState, type KeyboardEvent, type ReactNode } from "react";
import {
    ArrowDownIcon,
    ArrowUpIcon,
    CaretRightIcon,
    MagnifyingGlassIcon,
    TextAaIcon,
    XIcon
} from "@phosphor-icons/react";
import {
    closeSearchPanel,
    findNext,
    findPrevious,
    getSearchQuery,
    replaceAll,
    replaceNext,
    SearchQuery,
    setSearchQuery
} from "@codemirror/search";
import type { EditorState, Text } from "@codemirror/state";
import { EditorView, runScopeHandlers } from "@codemirror/view";
import { cn } from "@/lib/cn";
import { IconButton } from "@/ui";

/** Matches counted past this show as "1000+". */
const COUNT_LIMIT = 1000;

type Spec = {
    search: string;
    replace: string;
    caseSensitive: boolean;
    wholeWord: boolean;
    regexp: boolean;
    literal: boolean;
};

const specOf = (query: SearchQuery): Spec => ({
    search: query.search,
    replace: query.replace,
    literal: query.literal,
    caseSensitive: query.caseSensitive,
    wholeWord: query.wholeWord,
    regexp: query.regexp
});

/** Where each match starts and ends, up to `COUNT_LIMIT` (+1, to know there are more). */
function matchesOf(doc: Text, query: SearchQuery) {
    const found: { from: number; to: number }[] = [];
    if (!query.valid || !query.search) return found;
    const cursor = query.getCursor(doc);
    for (let next = cursor.next(); !next.done; next = cursor.next()) {
        found.push(next.value);
        if (found.length > COUNT_LIMIT) break;
    }
    return found;
}

/** Sets the query and, while typing, selects the first match from the caret on. */
function setQuery(view: EditorView, spec: Spec, jump: boolean) {
    const query = new SearchQuery(spec);
    view.dispatch({ effects: setSearchQuery.of(query) });
    if (!jump || !query.valid || !query.search) return;
    const from = view.state.selection.main.from;
    let match = query.getCursor(view.state, from).next();
    if (match.done) match = query.getCursor(view.state, 0, from).next();
    if (match.done) return;
    view.dispatch({
        selection: { anchor: match.value.from, head: match.value.to },
        effects: EditorView.scrollIntoView(match.value.from, { y: "center" })
    });
}

const fieldClass = cn(
    "flex h-7 min-w-0 flex-1 cursor-text items-center gap-1.5 rounded-md border border-border bg-bg px-2",
    "transition-colors focus-within:border-muted/50"
);
const inputClass = "min-w-0 flex-1 bg-transparent text-xs text-text outline-none placeholder:text-muted/70";
const textButtonClass = cn(
    "h-7 shrink-0 rounded-md px-2 text-xs text-muted transition-colors hover:bg-hover hover:text-text",
    "disabled:pointer-events-none disabled:opacity-40"
);

/** The find (and replace) widget over an editor; `search.ts` mounts it. */
export function SearchPanel({ view, state }: { view: EditorView; state: EditorState }) {
    const query = getSearchQuery(state);
    const spec = specOf(query);
    const editable = !state.readOnly;
    const [replacing, setReplacing] = useState(false);
    const showReplace = replacing && editable;

    const matches = matchesOf(state.doc, query);
    const { from, to } = state.selection.main;
    const index = matches.findIndex((m) => m.from === from && m.to === to);
    const total = matches.length > COUNT_LIMIT ? `${COUNT_LIMIT}+` : `${matches.length}`;

    const invalid = !!query.search && !query.valid;
    const count = !query.search
        ? ""
        : invalid
          ? "Invalid"
          : matches.length === 0
            ? "No results"
            : index >= 0
              ? `${index + 1} of ${total}`
              : `${total} found`;

    const update = (patch: Partial<Spec>, jump = false) => setQuery(view, { ...spec, ...patch }, jump);
    const close = () => {
        closeSearchPanel(view);
        view.focus();
    };

    const keys = (event: KeyboardEvent<HTMLInputElement>, field: "find" | "replace") => {
        if (event.key === "Escape") {
            event.preventDefault();
            close();
        } else if (event.key === "Enter" && field === "find") {
            event.preventDefault();
            (event.shiftKey ? findPrevious : findNext)(view);
        } else if (event.key === "Enter" && field === "replace") {
            event.preventDefault();
            (event.metaKey || event.ctrlKey ? replaceAll : replaceNext)(view);
        } else if (runScopeHandlers(view, event.nativeEvent, "search-panel")) {
            event.preventDefault();
        }
    };

    const option = (key: "caseSensitive" | "wholeWord" | "regexp", label: string, glyph: ReactNode) => (
        <IconButton
            label={label}
            aria-pressed={spec[key]}
            // Clicking keeps the caret in the field.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => update({ [key]: !spec[key] })}
            className={cn("size-5 rounded", spec[key] && "bg-info/15 text-info hover:bg-info/20 hover:text-info")}
        >
            {glyph}
        </IconButton>
    );

    return (
        <div
            role="search"
            className="flex w-[420px] max-w-full flex-col gap-1 rounded-lg border border-border bg-surface p-1 font-sans shadow-lg shadow-shadow/40"
        >
            <div className="flex items-center gap-0.5">
                {editable && (
                    <IconButton
                        label={showReplace ? "Hide replace" : "Replace"}
                        onClick={() => setReplacing((r) => !r)}
                        aria-expanded={showReplace}
                        className="w-5"
                    >
                        <CaretRightIcon className={cn("size-3 transition-transform", showReplace && "rotate-90")} />
                    </IconButton>
                )}
                <label className={cn(fieldClass, invalid && "border-danger/60 focus-within:border-danger/60")}>
                    <MagnifyingGlassIcon className="size-3 shrink-0 text-muted" />
                    <input
                        main-field="true"
                        type="text"
                        value={spec.search}
                        onChange={(event) => update({ search: event.target.value }, true)}
                        onKeyDown={(event) => keys(event, "find")}
                        placeholder="Find"
                        aria-label="Find"
                        spellCheck={false}
                        autoComplete="off"
                        className={inputClass}
                    />
                    <span className="-mr-1 flex shrink-0 items-center gap-px">
                        {option("caseSensitive", "Match case", <TextAaIcon className="size-3.5" />)}
                        {option(
                            "wholeWord",
                            "Match whole word",
                            <span className="text-[10px] leading-none font-semibold underline underline-offset-2">
                                ab
                            </span>
                        )}
                        {option(
                            "regexp",
                            "Use regular expression",
                            <span className="font-mono text-[10.5px] leading-none font-semibold">.*</span>
                        )}
                    </span>
                </label>
                <span
                    aria-live="polite"
                    className={cn(
                        "w-16 shrink-0 text-center text-[11px] tabular-nums",
                        invalid ? "text-danger" : "text-muted"
                    )}
                >
                    {count}
                </span>
                <IconButton
                    label="Previous match"
                    shortcut="Shift+Enter"
                    disabled={matches.length === 0}
                    onClick={() => findPrevious(view)}
                >
                    <ArrowUpIcon className="size-3.5" />
                </IconButton>
                <IconButton
                    label="Next match"
                    shortcut="Enter"
                    disabled={matches.length === 0}
                    onClick={() => findNext(view)}
                >
                    <ArrowDownIcon className="size-3.5" />
                </IconButton>
                <IconButton label="Close" shortcut="Escape" onClick={close}>
                    <XIcon className="size-3.5" />
                </IconButton>
            </div>
            {showReplace && (
                <div className="flex items-center gap-0.5 pl-5.5">
                    <label className={fieldClass}>
                        <input
                            type="text"
                            value={spec.replace}
                            onChange={(event) => update({ replace: event.target.value })}
                            onKeyDown={(event) => keys(event, "replace")}
                            placeholder="Replace"
                            aria-label="Replace"
                            spellCheck={false}
                            autoComplete="off"
                            className={inputClass}
                        />
                    </label>
                    <button
                        type="button"
                        disabled={matches.length === 0}
                        onClick={() => replaceNext(view)}
                        className={textButtonClass}
                    >
                        Replace
                    </button>
                    <button
                        type="button"
                        disabled={matches.length === 0}
                        onClick={() => replaceAll(view)}
                        className={textButtonClass}
                    >
                        All
                    </button>
                </div>
            )}
        </div>
    );
}
