import type { MouseEvent } from "react";
import { createCodePlugin } from "@streamdown/code";
import { createMathPlugin } from "@streamdown/math";
import { openUrl } from "@tauri-apps/plugin-opener";
import "katex/dist/katex.min.css";
import { Streamdown, type MermaidErrorComponentProps } from "streamdown";
import { cn } from "@/lib/cn";
import { isTauri } from "@/lib/platform";
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

/** A link would navigate the webview itself away; the system browser opens it instead. */
function openLinksExternally(event: MouseEvent) {
    if (!isTauri) return;
    const anchor = (event.target as Element).closest("a[href]");
    if (!anchor) return;
    event.preventDefault();
    void openUrl((anchor as HTMLAnchorElement).href);
}

/**
 * Agent output as markdown: GFM, Shiki-highlighted code, KaTeX math and
 * Mermaid diagrams (```mermaid fences; pan/zoom, fullscreen). Streamdown
 * re-renders only the block still growing and closes half-written syntax
 * mid-stream, so a half-sent `**bold` or code fence doesn't flash as raw
 * text. The look is the `.markdown` rules in `src/index.css`.
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
            >
                {children}
            </Streamdown>
        </div>
    );
}
