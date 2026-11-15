import type { MouseEvent } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Streamdown } from "streamdown";
import { cn } from "@/lib/cn";
import { isTauri } from "@/lib/platform";

/** Copy on code blocks; no table toolbar. */
const CONTROLS = { code: true, table: false } as const;

/** A link would navigate the webview itself away; the system browser opens it instead. */
function openLinksExternally(event: MouseEvent) {
    if (!isTauri) return;
    const anchor = (event.target as Element).closest("a[href]");
    if (!anchor) return;
    event.preventDefault();
    void openUrl((anchor as HTMLAnchorElement).href);
}

/**
 * Agent output as GFM markdown. Streamdown re-renders only the block still
 * growing and closes half-written syntax mid-stream, so a half-sent `**bold`
 * or code fence doesn't flash as raw text. The look is the `.markdown` rules
 * in `src/index.css`.
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
            >
                {children}
            </Streamdown>
        </div>
    );
}
