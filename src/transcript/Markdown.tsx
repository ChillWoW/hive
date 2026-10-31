import { use, type ComponentProps, type MouseEvent } from "react";
import { createCodePlugin } from "@streamdown/code";
import { createMathPlugin } from "@streamdown/math";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { Element as HastElement, Root, RootContent } from "hast";
import "katex/dist/katex.min.css";
import {
    defaultRehypePlugins,
    Streamdown,
    type ExtraProps,
    type MermaidErrorComponentProps
} from "streamdown";
import type { Pluggable, Plugin } from "unified";
import { useWorkspaceFiles } from "@/files";
import { cn } from "@/lib/cn";
import { isTauri } from "@/lib/platform";
import { FileLink } from "./FileLink";
import { WebLink } from "./WebLink";
import { ChatCwd } from "./context";
import {
    codeFileTarget,
    fileIndex,
    parseFileRef,
    resolveFileRef
} from "./filePaths";
import { mermaid } from "./mermaid";

// Module-level so every message shares one highlighter; Streamdown memoises
// on the plugin objects' identity. Both slots get the dark theme: the pair is
// picked by Tailwind's `dark:` variant, which follows the OS, and the app is
// dark whatever the OS says.
const plugins = {
    code: createCodePlugin({
        themes: ["github-dark-default", "github-dark-default"]
    }),
    // `$$…$$` only (inline when inside a line): single dollars are too often
    // prices or shell variables in agent output.
    math: createMathPlugin({ errorColor: "var(--color-danger)" }),
    mermaid
};

const CONTROLS = {
    code: { copy: true, download: false },
    table: false,
    mermaid: { copy: true, download: false, fullscreen: true, panZoom: true }
} as const;

/** A diagram that doesn't parse: the error and its source, in the app's colours. */
function MermaidError({ chart, error }: MermaidErrorComponentProps) {
    return (
        <div className="px-3 py-2.5 text-xs">
            <p className="font-mono text-danger">{error}</p>
            <pre className="mt-2 overflow-x-auto font-mono text-dark-200">{chart}</pre>
        </div>
    );
}

const MERMAID = { errorComponent: MermaidError };

/** The href a file link carries past `rehype-harden`, which blocks relative and `file:` ones. */
const FILE_HREF = "#hive-file:";

/** Moves file links' targets into a fragment harden lets through (`fileHref` reads it back). */
function markFileLinks() {
    const walk = (node: Root | RootContent) => {
        if (node.type !== "root" && node.type !== "element") return;
        if (node.type === "element") markLink(node);
        node.children.forEach(walk);
    };
    return walk;
}

function markLink(node: HastElement) {
    const href = node.properties.href;
    if (node.tagName !== "a" || typeof href !== "string" || !parseFileRef(href)) return;
    node.properties.href = FILE_HREF + encodeURIComponent(href);
}

const [sanitize, schema] = defaultRehypePlugins.sanitize as [
    Plugin,
    { protocols?: Record<string, string[]> }
];

/** Drive letters, so `C:\…` hrefs survive sanitizing as paths rather than schemes. */
const DRIVES = Array.from("abcdefghijklmnopqrstuvwxyz").flatMap((c) => [c, c.toUpperCase()]);

/**
 * Streamdown's own rehype chain, with `file:` and drive-letter hrefs let
 * through sanitizing and file links marked before hardening.
 */
const REHYPE_FILE_LINKS: Pluggable[] = [
    defaultRehypePlugins.raw,
    [
        sanitize,
        {
            ...schema,
            protocols: {
                ...schema.protocols,
                href: [...(schema.protocols?.href ?? []), "file", ...DRIVES]
            }
        }
    ],
    markFileLinks,
    defaultRehypePlugins.harden
];

const fileHref = (href: string | null) =>
    href?.startsWith(FILE_HREF) ? decodeURIComponent(href.slice(FILE_HREF.length)) : null;

/** A link would navigate the webview itself away; the system browser opens it instead. */
function openLinksExternally(event: MouseEvent) {
    if (!isTauri) return;
    const anchor = (event.target as Element).closest("a[href]");
    if (!anchor) return;
    event.preventDefault();
    void openUrl((anchor as HTMLAnchorElement).href);
}

const INLINE_CODE = "rounded bg-muted px-1.5 py-0.5 font-mono text-sm";

/** An inline code span; one naming a file of the chat (`src/a.ts:12`) is a `FileLink` instead. */
function InlineCode({ node: _, className, children, ...props }: ComponentProps<"code"> & ExtraProps) {
    const folder = use(ChatCwd);
    const entries = useWorkspaceFiles(folder, !!folder);
    const text = typeof children === "string" ? children : null;
    const target = text ? codeFileTarget(text, folder, entries && fileIndex(entries)) : null;
    if (target) return <FileLink target={target} />;
    return (
        <code {...props} className={cn(INLINE_CODE, className)} data-streamdown="inline-code">
            {children}
        </code>
    );
}

/**
 * A link: one to a file (marked by `markFileLinks`) is a `FileLink` with its
 * label, any other a `WebLink`.
 */
function Link({ node: _, href, children, ...props }: ComponentProps<"a"> & ExtraProps) {
    const folder = use(ChatCwd);
    const file = fileHref(href ?? null);
    if (file !== null) {
        const ref = parseFileRef(file);
        const target = ref && resolveFileRef(folder, ref);
        return target ? <FileLink target={target}>{children}</FileLink> : <span>{children}</span>;
    }
    if (!href) return <span>{children}</span>;
    return (
        <WebLink {...props} href={href}>
            {children}
        </WebLink>
    );
}

/** Web links everywhere; file paths only inside a transcript. */
const COMPONENTS = { a: Link };
const TRANSCRIPT_COMPONENTS = { inlineCode: InlineCode, a: Link };

/**
 * Agent output as markdown: GFM, Shiki-highlighted code, KaTeX math and
 * Mermaid diagrams (```mermaid fences; pan/zoom, fullscreen). Streamdown
 * re-renders only the block still growing and closes half-written syntax
 * mid-stream, so a half-sent `**bold` or code fence doesn't flash as raw
 * text. The look is the `.markdown` rules in `src/index.css`. Inside a
 * transcript (`ChatCwd`), file paths — links, and code spans naming a file —
 * open in Hive's editor.
 */
export function Markdown({
    children,
    streaming,
    className
}: {
    children: string;
    /** Still being written: a caret trails the text. */
    streaming?: boolean;
    className?: string;
}) {
    const folder = use(ChatCwd);
    return (
        <div onClickCapture={openLinksExternally}>
            <Streamdown
                className={cn("markdown", className)}
                plugins={plugins}
                isAnimating={streaming}
                caret="block"
                // Links already leave for the system browser.
                linkSafety={{ enabled: false }}
                // As zeron: code gets a copy button only, no line numbers;
                // tables no toolbar (see the `.markdown` rules).
                controls={CONTROLS}
                mermaid={MERMAID}
                lineNumbers={false}
                rehypePlugins={folder ? REHYPE_FILE_LINKS : undefined}
                components={folder ? TRANSCRIPT_COMPONENTS : COMPONENTS}
            >
                {children}
            </Streamdown>
        </div>
    );
}
