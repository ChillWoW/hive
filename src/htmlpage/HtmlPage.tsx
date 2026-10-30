import { useEffect, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
    ArrowClockwiseIcon,
    ArrowSquareOutIcon,
    ArrowsOutSimpleIcon
} from "@phosphor-icons/react";
import { isTauri } from "@/lib/platform";
import { iconButtonClassName, Modal, Tooltip } from "@/ui";
import { PAGE_SANDBOX, pageDocument, readMessage } from "./page";

/** A page `render_html` showed: Hive's saved copy, else the HTML the call carried. */
export type PageRef = { title: string; file?: string; html?: string; height?: number };

const MIN_HEIGHT = 80;
/** Past this the page scrolls inside its frame; full screen shows more. */
const MAX_HEIGHT = 1600;
const DEFAULT_HEIGHT = 320;

const clampHeight = (h: number) => Math.min(Math.max(Math.round(h), MIN_HEIGHT), MAX_HEIGHT);

/** Saved pages read back, by path; they never change. */
const documents = new Map<string, Promise<string>>();

function readPage(file: string): Promise<string> {
    let page = documents.get(file);
    if (!page) {
        page = isTauri
            ? invoke<ArrayBuffer>("attachment_bytes", { path: file }).then((bytes) =>
                  new TextDecoder().decode(bytes)
              )
            : Promise.reject(new Error("Pages need the Hive app."));
        page.catch(() => documents.delete(file));
        documents.set(file, page);
    }
    return page;
}

/** The page's document with the bootstrap in, once read; or why it can't be. */
function usePageDocument(page: PageRef) {
    const [state, setState] = useState<{ doc?: string; error?: string }>(() =>
        page.file || page.html === undefined ? {} : { doc: pageDocument(page.html) }
    );
    useEffect(() => {
        if (!page.file) return;
        let live = true;
        readPage(page.file).then(
            (html) => live && setState({ doc: pageDocument(html) }),
            (e: unknown) =>
                live &&
                (page.html !== undefined
                    ? setState({ doc: pageDocument(page.html) })
                    : setState({ error: e instanceof Error ? e.message : String(e) }))
        );
        return () => {
            live = false;
        };
    }, [page.file, page.html]);
    return state;
}

/**
 * A page from Hive's `render_html` tool, inline in the transcript where the
 * call was: a sandboxed frame (scripts run, nothing reaches Hive) that grows
 * to the page's height, as t3code's. On hover: its title, Reload, Open in
 * browser (the saved copy) and Full screen. Links open in the system browser,
 * only after a click inside the frame.
 */
export function HtmlPage({ page }: { page: PageRef }) {
    const { doc, error } = usePageDocument(page);
    const [height, setHeight] = useState(() => clampHeight(page.height ?? DEFAULT_HEIGHT));
    const [reloads, setReloads] = useState(0);
    const [fullScreen, setFullScreen] = useState(false);
    const frame = useLinkedFrame((h) => setHeight(clampHeight(h)));

    if (error) {
        return (
            <div className="flex h-10 items-center rounded-md border border-dark-600 px-3 text-xs text-dark-250">
                Page unavailable: {error}
            </div>
        );
    }

    return (
        <div className="group/page relative">
            {doc ? (
                <iframe
                    key={reloads}
                    ref={frame}
                    title={page.title}
                    srcDoc={doc}
                    sandbox={PAGE_SANDBOX}
                    style={{ height, colorScheme: "dark" }}
                    className="block w-full border-0 bg-transparent"
                />
            ) : (
                <div style={{ height }} />
            )}
            <div className="absolute -top-3 right-0 flex items-center gap-0.5 rounded-md border border-dark-600 bg-dark-850 py-0.5 pr-0.5 pl-2 opacity-0 shadow-md shadow-black/30 transition-opacity group-hover/page:opacity-100 focus-within:opacity-100">
                <span className="mr-1 max-w-56 truncate text-[11.5px] text-dark-200">{page.title}</span>
                <ToolbarButton label="Reload" onClick={() => setReloads((n) => n + 1)}>
                    <ArrowClockwiseIcon className="size-3.5" />
                </ToolbarButton>
                {page.file && (
                    <ToolbarButton
                        label="Open in browser"
                        onClick={() => void invoke("open_attachment", { path: page.file })}
                    >
                        <ArrowSquareOutIcon className="size-3.5" />
                    </ToolbarButton>
                )}
                <ToolbarButton label="Full screen" onClick={() => setFullScreen(true)}>
                    <ArrowsOutSimpleIcon className="size-3.5" />
                </ToolbarButton>
            </div>
            {doc && (
                <Modal
                    open={fullScreen}
                    onOpenChange={setFullScreen}
                    title={page.title}
                    className="w-[92%] max-w-none"
                    bodyClassName="h-[calc(86vh-6rem)]"
                >
                    <FullScreenFrame title={page.title} doc={doc} />
                </Modal>
            )}
        </div>
    );
}

function FullScreenFrame({ title, doc }: { title: string; doc: string }) {
    const frame = useLinkedFrame();
    return (
        <iframe
            ref={frame}
            title={title}
            srcDoc={doc}
            sandbox={PAGE_SANDBOX}
            style={{ colorScheme: "dark" }}
            className="block size-full border-0 bg-transparent"
        />
    );
}

/**
 * A ref for a page's frame that listens to it: its height (to `onHeight`)
 * and its link clicks, opened in the system browser only while the frame
 * has focus (the user clicked in it), so a page can't open links on its own.
 */
function useLinkedFrame(onHeight?: (height: number) => void) {
    const ref = useRef<HTMLIFrameElement | null>(null);
    const heightRef = useRef(onHeight);
    heightRef.current = onHeight;
    useEffect(() => {
        const onMessage = (event: MessageEvent) => {
            const message = readMessage(event, ref.current);
            if (!message) return;
            if (message.type === "size") heightRef.current?.(message.height);
            else if (message.type === "link" && document.activeElement === ref.current && isTauri) {
                void openUrl(message.url);
            }
        };
        window.addEventListener("message", onMessage);
        return () => window.removeEventListener("message", onMessage);
    }, []);
    return ref;
}

function ToolbarButton({
    label,
    onClick,
    children
}: {
    label: string;
    onClick: () => void;
    children: ReactNode;
}) {
    return (
        <Tooltip>
            <Tooltip.Trigger
                render={
                    <button type="button" aria-label={label} onClick={onClick} className={iconButtonClassName}>
                        {children}
                    </button>
                }
            />
            <Tooltip.Content side="bottom">{label}</Tooltip.Content>
        </Tooltip>
    );
}
