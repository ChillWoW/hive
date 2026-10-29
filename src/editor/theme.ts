import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";

/**
 * The editor's look: the app's dark surfaces, and syntax colours from
 * `github-dark-default`, the Shiki theme the transcript's code blocks use, so
 * code reads the same in both.
 */
const chrome = EditorView.theme(
    {
        "&": {
            height: "100%",
            color: "#e6edf3",
            backgroundColor: "transparent",
            fontSize: "12px"
        },
        "&.cm-focused": { outline: "none" },
        ".cm-scroller": {
            fontFamily:
                'ui-monospace, "SF Mono", "Cascadia Code", Menlo, Consolas, monospace',
            lineHeight: "1.6",
            overscrollBehavior: "contain"
        },
        ".cm-content": { padding: "6px 0", caretColor: "#e6edf3" },
        ".cm-line": { padding: "0 12px 0 6px" },
        ".cm-cursor, .cm-dropCursor": { borderLeftColor: "#e6edf3" },
        "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
            { backgroundColor: "rgba(56, 139, 253, 0.28)" },
        ".cm-activeLine": { backgroundColor: "rgba(255, 255, 255, 0.03)" },
        ".cm-gutters": {
            backgroundColor: "transparent",
            color: "#5a5a5a",
            border: "none"
        },
        ".cm-lineNumbers .cm-gutterElement": { padding: "0 4px 0 12px", minWidth: "32px" },
        ".cm-activeLineGutter": { backgroundColor: "transparent", color: "#b8b8b8" },
        ".cm-selectionMatch": { backgroundColor: "rgba(255, 255, 255, 0.08)" },
        "&.cm-focused .cm-matchingBracket": {
            backgroundColor: "rgba(255, 255, 255, 0.1)",
            outline: "1px solid rgba(255, 255, 255, 0.15)"
        },
        ".cm-searchMatch": { backgroundColor: "rgba(187, 128, 9, 0.35)" },
        ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "rgba(187, 128, 9, 0.6)" },
        ".cm-foldPlaceholder": {
            backgroundColor: "#2e2e2e",
            border: "none",
            color: "#b8b8b8"
        },
        ".cm-tooltip": {
            backgroundColor: "#1f1f1f",
            border: "1px solid #2e2e2e",
            borderRadius: "6px"
        },
        ".cm-tooltip-autocomplete > ul > li[aria-selected]": {
            backgroundColor: "#2e2e2e",
            color: "#e6edf3"
        },
        ".cm-panels": { backgroundColor: "#1a1a1a", color: "#c9c9c9" },
        ".cm-panels.cm-panels-top": { borderBottom: "1px solid #2e2e2e" },
        ".cm-panels.cm-panels-bottom": { borderTop: "1px solid #2e2e2e" },
        ".cm-panel.cm-search": { padding: "6px 8px", fontSize: "12px" },
        ".cm-panel.cm-search input, .cm-panel.cm-search button": {
            fontSize: "12px",
            borderRadius: "4px"
        },
        ".cm-textfield": {
            backgroundColor: "#242424",
            border: "1px solid #3b3b3b",
            color: "#c9c9c9"
        },
        ".cm-button": {
            backgroundImage: "none",
            backgroundColor: "#242424",
            border: "1px solid #3b3b3b",
            color: "#c9c9c9"
        }
    },
    { dark: true }
);

const highlight = HighlightStyle.define([
    { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: "#8b949e" },
    {
        tag: [t.keyword, t.controlKeyword, t.operatorKeyword, t.definitionKeyword, t.modifier],
        color: "#ff7b72"
    },
    { tag: [t.string, t.special(t.string), t.character, t.regexp], color: "#a5d6ff" },
    { tag: [t.escape], color: "#79c0ff" },
    { tag: [t.number, t.bool, t.null, t.atom, t.constant(t.name)], color: "#79c0ff" },
    {
        tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName],
        color: "#d2a8ff"
    },
    { tag: [t.typeName, t.className, t.namespace, t.definition(t.typeName)], color: "#ffa657" },
    { tag: [t.propertyName, t.attributeName], color: "#79c0ff" },
    { tag: [t.tagName, t.angleBracket], color: "#7ee787" },
    { tag: [t.operator, t.punctuation, t.separator, t.bracket], color: "#e6edf3" },
    { tag: [t.variableName, t.self], color: "#e6edf3" },
    { tag: [t.definition(t.variableName)], color: "#ffa657" },
    { tag: [t.meta, t.annotation, t.processingInstruction], color: "#79c0ff" },
    { tag: t.heading, color: "#79c0ff", fontWeight: "600" },
    { tag: t.strong, fontWeight: "600" },
    { tag: t.emphasis, fontStyle: "italic" },
    { tag: t.strikethrough, textDecoration: "line-through" },
    { tag: [t.link, t.url], color: "#a5d6ff", textDecoration: "underline" },
    { tag: [t.monospace], color: "#79c0ff" },
    { tag: t.invalid, color: "#ffa198" },
    { tag: [t.inserted], color: "#aff5b4" },
    { tag: [t.deleted], color: "#ffdcd7" }
]);

export const editorTheme = [chrome, syntaxHighlighting(highlight)];
