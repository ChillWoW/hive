import { HighlightStyle, syntaxHighlighting, type TagStyle } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";

/** `var(--name)` at `percent`% over transparent. */
const tint = (name: string, percent: number) =>
    `color-mix(in srgb, var(--${name}) ${percent}%, transparent)`;

/**
 * The editor's look: the theme's tokens (CSS variables, so a theme switch
 * restyles open editors without a reconfigure) and the code font.
 */
const chrome = EditorView.theme({
    "&": {
        height: "100%",
        color: "var(--text)",
        backgroundColor: "transparent",
        fontSize: "12px"
    },
    "&.cm-focused": { outline: "none" },
    ".cm-scroller": {
        fontFamily: "var(--font-mono)",
        lineHeight: "1.65",
        overscrollBehavior: "contain"
    },
    ".cm-content": { padding: "8px 0 40vh", caretColor: "var(--text)" },
    ".cm-line": { padding: "0 16px 0 8px" },
    ".cm-cursor, .cm-dropCursor": { borderLeft: "1.5px solid var(--text)" },
    "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
        { backgroundColor: tint("info", 26) },
    ".cm-activeLine": { backgroundColor: tint("text", 3.5) },
    ".cm-gutters": {
        backgroundColor: "transparent",
        color: tint("muted", 65),
        border: "none"
    },
    ".cm-lineNumbers .cm-gutterElement": { padding: "0 6px 0 14px", minWidth: "36px" },
    ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--text)" },
    ".cm-selectionMatch": { backgroundColor: tint("text", 9) },
    "&.cm-focused .cm-matchingBracket": {
        backgroundColor: tint("text", 10),
        outline: `1px solid ${tint("text", 18)}`,
        borderRadius: "2px"
    },
    ".cm-searchMatch": { backgroundColor: tint("warning", 28), borderRadius: "2px" },
    ".cm-searchMatch.cm-searchMatch-selected": {
        backgroundColor: tint("warning", 55),
        outline: `1px solid ${tint("warning", 80)}`
    },
    ".cm-foldPlaceholder": {
        backgroundColor: "var(--raised)",
        border: "none",
        color: "var(--muted)"
    },
    ".cm-tooltip": {
        backgroundColor: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: "8px",
        color: "var(--text)"
    },
    ".cm-tooltip-autocomplete > ul > li[aria-selected]": {
        backgroundColor: "var(--hover)",
        color: "var(--text)"
    },
    // The find widget (`searchPanel.tsx`) floats over the code's top right.
    ".cm-panels": { backgroundColor: "transparent", color: "var(--text)" },
    ".cm-panels.cm-panels-top": {
        position: "absolute",
        top: "8px",
        left: "auto",
        right: "12px",
        maxWidth: "calc(100% - 24px)",
        border: "none"
    }
});

/** Light then dark: GitHub's colours, as the transcript's code blocks (Shiki's `github-light`/`-dark`). */
const c = (light: string, dark: string) => `light-dark(${light}, ${dark})`;

/** The syntax colours; they follow the theme's `color-scheme`. */
const HIGHLIGHT_SPECS: TagStyle[] = [
    { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: c("#6e7781", "#8b949e") },
    {
        tag: [t.keyword, t.controlKeyword, t.operatorKeyword, t.definitionKeyword, t.modifier],
        color: c("#cf222e", "#ff7b72")
    },
    { tag: [t.string, t.special(t.string), t.character, t.regexp], color: c("#0a3069", "#a5d6ff") },
    { tag: [t.escape], color: c("#0550ae", "#79c0ff") },
    { tag: [t.number, t.bool, t.null, t.atom, t.constant(t.name)], color: c("#0550ae", "#79c0ff") },
    {
        tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName],
        color: c("#8250df", "#d2a8ff")
    },
    {
        tag: [t.typeName, t.className, t.namespace, t.definition(t.typeName)],
        color: c("#953800", "#ffa657")
    },
    { tag: [t.propertyName, t.attributeName], color: c("#0550ae", "#79c0ff") },
    { tag: [t.tagName, t.angleBracket], color: c("#116329", "#7ee787") },
    { tag: [t.operator, t.punctuation, t.separator, t.bracket], color: "var(--text)" },
    { tag: [t.variableName, t.self], color: "var(--text)" },
    { tag: [t.definition(t.variableName)], color: c("#953800", "#ffa657") },
    { tag: [t.meta, t.annotation, t.processingInstruction], color: c("#0550ae", "#79c0ff") },
    { tag: t.heading, color: c("#0550ae", "#79c0ff"), fontWeight: "600" },
    { tag: t.strong, fontWeight: "600" },
    { tag: t.emphasis, fontStyle: "italic" },
    { tag: t.strikethrough, textDecoration: "line-through" },
    { tag: [t.link, t.url], color: c("#0a3069", "#a5d6ff"), textDecoration: "underline" },
    { tag: [t.monospace], color: c("#0550ae", "#79c0ff") },
    { tag: t.invalid, color: c("#82071e", "#ffa198") },
    { tag: [t.inserted], color: c("#116329", "#aff5b4") },
    { tag: [t.deleted], color: c("#82071e", "#ffdcd7") }
];

export const editorTheme = [chrome, syntaxHighlighting(HighlightStyle.define(HIGHLIGHT_SPECS))];
