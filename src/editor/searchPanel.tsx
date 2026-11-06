import { useMemo, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import {
    CaretDownIcon,
    CaretRightIcon,
    CaretUpIcon,
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
    search,
    SearchQuery,
    setSearchQuery
} from "@codemirror/search";
import type { EditorState } from "@codemirror/state";
import { EditorView, runScopeHandlers, type Panel } from "@codemirror/view";
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
function matchesOf(state: EditorState, query: SearchQuery) {
    const found: { from: number; to: number }[] = [];
    if (!query.valid || !query.search) return found;
    const cursor = query.getCursor(state);
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

const fieldClass =
    "flex h-6 min-w-0 flex-1 cursor-text items-center gap-1.5 rounded-md bg-white/[0.035] px-2 transition-colors hover:bg-white/[0.055] focus-within:bg-white/[0.055]";
const inputClass =
    "min-w-0 flex-1 bg-transparent text-[12px] text-dark-50 outline-none placeholder:text-dark-200";
const textButtonClass =
    "h-6 shrink-0 rounded-md px-2 text-[11.5px] text-dark-100 transition-colors hover:bg-white/[0.06] hover:text-dark-50 disabled:pointer-events-none disabled:opacity-40";

function SearchPanel({ view, state }: { view: EditorView; state: EditorState }) {
    const query = getSearchQuery(state);
    const spec = specOf(query);
    const editable = !state.readOnly;
    const [replacing, setReplacing] = useState(false);
    const showReplace = replacing && editable;

    const matches = useMemo(() => matchesOf(state, query), [state.doc, query]); // eslint-disable-line react-hooks/exhaustive-deps
    const { from, to } = state.selection.main;
    const index = matches.findIndex((m) => m.from === from && m.to === to);
    const more = matches.length > COUNT_LIMIT;
    const total = more ? `${COUNT_LIMIT}+` : `${matches.length}`;

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

    const keys = (event: React.KeyboardEvent<HTMLInputElement>, field: "find" | "replace") => {
        const native = event.nativeEvent;
        if (event.key === "Escape") {
            event.preventDefault();
            closeSearchPanel(view);
            view.focus();
        } else if (event.key === "Enter" && field === "find") {
            event.preventDefault();
            (event.shiftKey ? findPrevious : findNext)(view);
        } else if (event.key === "Enter" && field === "replace") {
            event.preventDefault();
            (event.metaKey || event.ctrlKey ? replaceAll : replaceNext)(view);
        } else if (runScopeHandlers(view, native, "search-panel")) {
            event.preventDefault();
        }
    };

    const option = (key: "caseSensitive" | "wholeWord" | "regexp", label: string, glyph: ReactNode) => (
        <IconButton
            label={label}
            aria-pressed={spec[key]}
            // Clicking keeps the caret in the field.
            onMouseDown={(event) => event.preventDefault()}
            onClick={(event) => {
                event.preventDefault();
                update({ [key]: !spec[key] });
            }}
            className={cn(
                "size-[18px] rounded text-dark-250",
                spec[key] && "bg-info/20 text-info hover:bg-info/25 hover:text-info"
            )}
        >
            {glyph}
        </IconButton>
    );

    return (
        <div
            role="search"
            className="flex w-[440px] max-w-full flex-col gap-1 rounded-xl border border-dark-600 bg-dark-850 p-1 font-sans shadow-lg shadow-black/40"
        >
            <div className="flex items-center gap-1">
                {editable && (
                    <IconButton
                        label={showReplace ? "Hide replace" : "Replace"}
                        onClick={() => setReplacing((r) => !r)}
                        aria-expanded={showReplace}
                        className="size-6"
                    >
                        <CaretRightIcon
                            className={cn("size-3 transition-transform", showReplace && "rotate-90")}
                        />
                    </IconButton>
                )}
                <label className={cn(fieldClass, invalid && "ring-1 ring-danger/50")}>
                    <MagnifyingGlassIcon className="size-3 shrink-0 text-dark-200" />
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
                    <span className="-mr-1.5 flex shrink-0 items-center gap-px">
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
                        "w-[68px] shrink-0 text-center text-[11px] tabular-nums",
                        invalid ? "text-danger" : matches.length === 0 ? "text-dark-250" : "text-dark-100"
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
                    <CaretUpIcon className="size-3.5" />
                </IconButton>
                <IconButton
                    label="Next match"
                    shortcut="Enter"
                    disabled={matches.length === 0}
                    onClick={() => findNext(view)}
                >
                    <CaretDownIcon className="size-3.5" />
                </IconButton>
                <IconButton
                    label="Close"
                    shortcut="Escape"
                    onClick={() => {
                        closeSearchPanel(view);
                        view.focus();
                    }}
                >
                    <XIcon className="size-3.5" />
                </IconButton>
            </div>
            {showReplace && (
                <div className="flex items-center gap-1 pl-7">
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
                        Replace all
                    </button>
                </div>
            )}
        </div>
    );
}

/** The find widget, floating at the editor's top right, drawn by React. */
function createSearchPanel(view: EditorView): Panel {
    const dom = document.createElement("div");
    dom.className = "cm-hive-search";
    const root = createRoot(dom);
    // Synchronously, so `openSearchPanel` finds the field with its new query to select.
    const render = (state: EditorState) =>
        flushSync(() => root.render(<SearchPanel view={view} state={state} />));
    render(view.state);
    return {
        dom,
        top: true,
        mount() {
            const input = dom.querySelector<HTMLInputElement>("[main-field]");
            input?.focus();
            input?.select();
        },
        update(update) {
            if (update.state !== update.startState) render(update.state);
        },
        destroy() {
            // Not while CodeMirror (maybe inside a React render) is updating.
            setTimeout(() => root.unmount());
        }
    };
}

export const searchExtension = search({ createPanel: createSearchPanel });
