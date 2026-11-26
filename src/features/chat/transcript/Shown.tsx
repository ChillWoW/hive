import { ImageIcon, BrowserIcon } from "@phosphor-icons/react";
import type { Attachment } from "@/proto";
import { useAttachmentUrl } from "@/features/chats/attachments";
import type { ToolPart } from "../fold";

type Result = { attachment?: Attachment; caption?: string; title?: string; height?: number };

function result(part: ToolPart): Result | undefined {
    if (!part.resolved || part.isError || !part.output) return undefined;
    try {
        return JSON.parse(part.output) as Result;
    } catch {
        return undefined;
    }
}

/**
 * What Outcode's display tools showed, where the agent called them: an
 * image or SVG (drawn as an `<img>`, so an SVG's scripts never run), or an
 * HTML page in a sandboxed frame whose scripts run with no access to the app.
 */
export function Shown({ part }: { part: ToolPart }) {
    const shown = result(part);
    const html = part.call.kind === "mcp" && part.call.tool === "render_html";
    if (!shown?.attachment) {
        const Icon = html ? BrowserIcon : ImageIcon;
        return (
            <div className="flex h-[26px] items-center gap-2 text-[13px] text-muted/85">
                <Icon className="size-3.5 shrink-0" />
                {part.isError ? (
                    <span className="text-danger">Couldn&apos;t show it{part.output ? `: ${part.output}` : ""}</span>
                ) : (
                    <span className="shimmer">{html ? "Rendering a page" : "Showing an image"}</span>
                )}
            </div>
        );
    }
    return html ? (
        <Page attachment={shown.attachment} title={shown.title} height={shown.height ?? 420} />
    ) : (
        <Picture attachment={shown.attachment} caption={shown.caption} />
    );
}

function Picture({ attachment, caption }: { attachment: Attachment; caption?: string }) {
    const url = useAttachmentUrl(attachment);
    return (
        <figure className="flex flex-col gap-1.5">
            {url ? (
                <img src={url} alt={caption ?? attachment.name} className="max-h-[640px] max-w-full self-start rounded-lg" />
            ) : (
                <div className="h-40 w-64 animate-pulse rounded-lg bg-raised" />
            )}
            {caption && <figcaption className="text-xs text-muted">{caption}</figcaption>}
        </figure>
    );
}

function Page({ attachment, title, height }: { attachment: Attachment; title?: string; height: number }) {
    const url = useAttachmentUrl({ ...attachment, mimeType: "text/html" });
    return (
        <figure className="flex flex-col gap-1.5">
            {title && <figcaption className="text-xs font-medium text-muted">{title}</figcaption>}
            {url ? (
                <iframe
                    title={title ?? "Page"}
                    src={url}
                    // Scripts run; same-origin, forms, popups and top navigation don't.
                    sandbox="allow-scripts"
                    style={{ height }}
                    className="w-full rounded-lg border border-border bg-transparent"
                />
            ) : (
                <div style={{ height }} className="w-full animate-pulse rounded-lg bg-raised" />
            )}
        </figure>
    );
}
