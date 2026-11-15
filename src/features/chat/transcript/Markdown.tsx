import { use, type ComponentProps, type MouseEvent } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { Element as HastElement, Root, RootContent } from "hast";
import { defaultRehypePlugins, Streamdown, type ExtraProps } from "streamdown";
import type { Pluggable, Plugin } from "unified";
import { cn } from "@/lib/cn";
import { isTauri } from "@/lib/platform";
import { ChatCwd, KnownFiles } from "./context";
import { FileLink } from "./FileLink";
import { codeFileTarget, parseFileRef, resolveFileRef } from "./filePaths";
import { WebLink } from "./WebLink";

/** Copy on code blocks; no table toolbar. */
const CONTROLS = { code: true, table: false } as const;

/** The href a file link carries past `rehype-harden`, which blocks relative and `file:` ones. */
const FILE_HREF = "#outcode-file:";

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
    defaultRehypePlugins.raw!,
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
    defaultRehypePlugins.harden!
];

const fileHref = (href: string | null) =>
    href?.startsWith(FILE_HREF) ? decodeURIComponent(href.slice(FILE_HREF.length)) : null;

/** A link would navigate the webview itself away; the system browser opens it instead. */
function openLinksExternally(event: MouseEvent) {
    const anchor = (event.target as Element).closest("a[href]");
    if (!anchor) return;
    event.preventDefault();
    const href = (anchor as HTMLAnchorElement).href;
    if (isTauri) void openUrl(href);
    else window.open(href, "_blank", "noreferrer");
}

/** Props without the hast `node` Streamdown passes, which the DOM mustn't get. */
function withoutNode<T extends ExtraProps>(props: T): Omit<T, "node"> {
    const copy = { ...props };
    delete copy.node;
    return copy;
}

const INLINE_CODE = "rounded bg-raised px-1.5 py-0.5 font-mono text-sm";

/** An inline code span; one naming a file (`src/a.ts:12`) is a `FileLink` instead. */
function InlineCode({ className, children, ...rest }: ComponentProps<"code"> & ExtraProps) {
    const props = withoutNode(rest);
    const folder = use(ChatCwd);
    const known = use(KnownFiles);
    const text = typeof children === "string" ? children : null;
    const target = text ? codeFileTarget(text, folder, known) : null;
    if (target) return <FileLink target={target} />;
    return (
        <code {...props} className={cn(INLINE_CODE, className)} data-streamdown="inline-code">
            {children}
        </code>
    );
}

/** A link: one to a file (marked by `markFileLinks`) is a `FileLink` with its label, any other a `WebLink`. */
function Link({ href, children, ...rest }: ComponentProps<"a"> & ExtraProps) {
    const props = withoutNode(rest);
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

const COMPONENTS = { inlineCode: InlineCode, a: Link };

/**
 * Agent output as GFM markdown. Streamdown re-renders only the block still
 * growing and closes half-written syntax mid-stream, so a half-sent `**bold`
 * or code fence doesn't flash as raw text. Web links show the site's icon
 * and open in the system browser; file paths — links, and code spans naming
 * a file — open in the file's default app. The look is the `.markdown`
 * rules in `src/index.css`.
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
    return (
        <div onClickCapture={openLinksExternally}>
            <Streamdown
                className={cn("markdown", className)}
                isAnimating={streaming}
                caret="block"
                // Links already leave for the system browser.
                linkSafety={{ enabled: false }}
                controls={CONTROLS}
                lineNumbers={false}
                rehypePlugins={REHYPE_FILE_LINKS}
                components={COMPONENTS}
            >
                {children}
            </Streamdown>
        </div>
    );
}
