import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { search } from "@codemirror/search";
import type { EditorState } from "@codemirror/state";
import type { EditorView, Panel } from "@codemirror/view";
import { SearchPanel } from "./SearchPanel";

/** The find widget, floating at the editor's top right, drawn by React. */
function createSearchPanel(view: EditorView): Panel {
    const dom = document.createElement("div");
    const root = createRoot(dom);
    // Synchronously, so `openSearchPanel` finds the field with its new query to select.
    const render = (state: EditorState) => flushSync(() => root.render(createElement(SearchPanel, { view, state })));
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
