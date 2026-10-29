import { useEffect, useState, type ReactNode } from "react";
import {
    ArrowSquareOutIcon,
    CodeIcon,
    CrosshairIcon,
    EyeIcon,
    TextAlignLeftIcon
} from "@phosphor-icons/react";
import {
    CodeEditor,
    currentState,
    fileObjectUrl,
    openFile,
    overwrite,
    reloadFromDisk,
    save,
    togglePreview,
    unblockClose,
    useDocsStore,
    useEditorPrefs,
    isMarkdown,
    type Doc
} from "@/editor";
import { useFilesPanelStore } from "@/files/panel";
import type { ReadOnlyReason } from "@/proto";
import { cn } from "@/lib/cn";
import { useLayoutStore } from "@/stores/useLayoutStore";
import { Markdown } from "@/transcript/Markdown";
import { Button, FileIcon, iconButtonClassName, Tooltip } from "@/ui";
import { discardTab } from "./actions";
import type { RightTab } from "./store";

const IMAGE_TYPES: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    bmp: "image/bmp",
    ico: "image/x-icon",
    avif: "image/avif"
};
const imageType = (path: string) =>
    IMAGE_TYPES[path.slice(path.lastIndexOf(".") + 1).toLowerCase()];

const READ_ONLY: Record<ReadOnlyReason, string> = {
    tooLarge: "Too large to edit here (over 1 MB).",
    binary: "A binary file; it can't be shown as text.",
    unsupportedEncoding: "Not UTF-8 text; it can't be shown here.",
    mixedLineEndings: "Mixed line endings: read-only, so saving can't change them.",
    symlink: "A link; Hive doesn't follow links."
};

/** A file in the right sidebar: zeron's toolbar over its editor or preview. */
export function FileTab({ tab }: { tab: Extract<RightTab, { kind: "file" }> }) {
    const doc = useDocsStore((s) => s.docs[tab.id]);
    const image = imageType(tab.path);

    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <Toolbar tab={tab} doc={doc} image={!!image} />
            {doc && <Banners id={tab.id} doc={doc} />}
            {image ? (
                <ImagePreview cwd={tab.cwd} path={tab.path} type={image} />
            ) : !doc || doc.phase === "loading" ? null : doc.phase === "error" ? (
                <Notice>{doc.error}</Notice>
            ) : doc.file?.text == null ? (
                <Notice action={<OpenElsewhere cwd={tab.cwd} path={tab.path} />}>
                    {doc.file?.readOnly === "tooLarge"
                        ? "Too large to show here (over 8 MB)."
                        : READ_ONLY[doc.file?.readOnly ?? "binary"]}
                </Notice>
            ) : isMarkdown(tab.path) && doc.preview ? (
                <MarkdownPreview id={tab.id} version={doc.version} />
            ) : (
                <CodeEditor key={tab.id} id={tab.id} />
            )}
        </div>
    );
}

function Toolbar({
    tab,
    doc,
    image
}: {
    tab: Extract<RightTab, { kind: "file" }>;
    doc: Doc | undefined;
    image: boolean;
}) {
    const wrap = useEditorPrefs((s) => s.wrap);
    const toggleWrap = useEditorPrefs((s) => s.toggleWrap);
    const parts = tab.path.split("/");
    const editable = !image && doc?.file?.text != null;

    return (
        <div className="flex h-9 shrink-0 items-center gap-1 border-b border-dark-600 px-2">
            <FileIcon name={tab.title} className="size-3.5" />
            <Tooltip>
                <Tooltip.Trigger
                    render={
                        <div className="flex min-w-0 flex-1 items-center gap-1 truncate text-[11px]">
                            {parts.map((part, i) => (
                                <span key={i} className="flex min-w-0 shrink items-center gap-1">
                                    {i > 0 && <span className="text-dark-300">›</span>}
                                    <span
                                        className={cn(
                                            "truncate",
                                            i === parts.length - 1
                                                ? "text-dark-50"
                                                : "text-dark-200"
                                        )}
                                    >
                                        {part}
                                    </span>
                                </span>
                            ))}
                        </div>
                    }
                />
                <Tooltip.Content side="bottom">{tab.path}</Tooltip.Content>
            </Tooltip>

            {doc && <StatusLabel id={tab.id} doc={doc} />}

            {editable && isMarkdown(tab.path) && doc && (
                <ToolButton
                    label={doc.preview ? "Show Markdown code" : "Preview Markdown"}
                    onClick={() => togglePreview(tab.id)}
                >
                    {doc.preview ? <CodeIcon className="size-3.5" /> : <EyeIcon className="size-3.5" />}
                </ToolButton>
            )}
            <ToolButton
                label="Show in file tree"
                onClick={() => {
                    useFilesPanelStore.getState().revealPath(tab.cwd, tab.path, false);
                    useLayoutStore.getState().show("files");
                }}
            >
                <CrosshairIcon className="size-3.5" />
            </ToolButton>
            <ToolButton
                label="Open in default app"
                onClick={() =>
                    openFile(tab.cwd, tab.path).catch((error: unknown) =>
                        console.warn("[editor] open failed", error)
                    )
                }
            >
                <ArrowSquareOutIcon className="size-3.5" />
            </ToolButton>
            {editable && (
                <ToolButton
                    label={wrap ? "Don't wrap lines" : "Wrap lines"}
                    pressed={wrap}
                    onClick={toggleWrap}
                >
                    <TextAlignLeftIcon className="size-3.5" />
                </ToolButton>
            )}
        </div>
    );
}

function ToolButton({
    label,
    pressed,
    onClick,
    children
}: {
    label: string;
    pressed?: boolean;
    onClick: () => void;
    children: ReactNode;
}) {
    return (
        <Tooltip>
            <Tooltip.Trigger
                render={
                    <button
                        type="button"
                        aria-label={label}
                        aria-pressed={pressed}
                        onClick={onClick}
                        className={cn(iconButtonClassName, pressed && "bg-white/10 text-dark-50")}
                    >
                        {children}
                    </button>
                }
            />
            <Tooltip.Content side="bottom">{label}</Tooltip.Content>
        </Tooltip>
    );
}

/** Zeron's status words: only when something's wrong. */
function StatusLabel({ id, doc }: { id: string; doc: Doc }) {
    const status = doc.status;
    if (!status) return null;
    const [text, detail, tone] =
        status.kind === "saveFailed"
            ? ["Save failed", `${status.message} Click to try again.`, "text-danger"]
            : status.kind === "conflict"
              ? ["Save conflict", "The file changed on disk since it was opened.", "text-warning"]
              : status.kind === "changed"
                ? ["Changed on disk", "The file changed outside Hive.", "text-warning"]
                : ["Deleted on disk", "The file is gone from disk.", "text-danger"];
    return (
        <Tooltip>
            <Tooltip.Trigger
                render={
                    <button
                        type="button"
                        onClick={() => status.kind === "saveFailed" && void save(id)}
                        className={cn(
                            "shrink-0 rounded px-1.5 py-0.5 text-[11px] outline-none hover:bg-white/[0.06]",
                            tone
                        )}
                    >
                        {text}
                    </button>
                }
            />
            <Tooltip.Content side="bottom">{detail}</Tooltip.Content>
        </Tooltip>
    );
}

function Banner({ children, actions }: { children: ReactNode; actions: ReactNode }) {
    return (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-dark-600 bg-dark-800 px-3 py-2 text-[11.5px] text-dark-100">
            <span className="min-w-0 flex-1">{children}</span>
            <span className="flex shrink-0 gap-1.5">{actions}</span>
        </div>
    );
}

/** What needs settling: a close waiting on a failed save, a change on disk, a conflict… */
function Banners({ id, doc }: { id: string; doc: Doc }) {
    if (doc.closeBlocked) {
        return (
            <Banner
                actions={
                    <>
                        <Button size="sm" onClick={() => unblockClose(id)}>
                            Keep open
                        </Button>
                        <Button size="sm" variant="destructive" onClick={() => discardTab(id)}>
                            Discard changes
                        </Button>
                    </>
                }
            >
                Changes couldn't be saved, so the tab stayed open.
            </Banner>
        );
    }
    if (doc.status?.kind === "changed" || doc.status?.kind === "conflict") {
        return (
            <Banner
                actions={
                    <>
                        <Button size="sm" onClick={() => void reloadFromDisk(id)}>
                            Reload from disk
                        </Button>
                        <Button size="sm" onClick={() => void overwrite(id)}>
                            Overwrite
                        </Button>
                    </>
                }
            >
                {doc.status.kind === "changed"
                    ? "This file changed outside Hive."
                    : "This file changed on disk since it was opened, so it wasn't saved."}
            </Banner>
        );
    }
    if (doc.status?.kind === "deleted") {
        return (
            <Banner
                actions={
                    <Button size="sm" onClick={() => discardTab(id)}>
                        Close tab
                    </Button>
                }
            >
                This file was deleted on disk.
            </Banner>
        );
    }
    if (doc.file?.text != null && doc.file.readOnly) {
        return (
            <div className="shrink-0 border-b border-dark-600 px-3 py-1.5 text-[11px] text-dark-200">
                Read-only. {READ_ONLY[doc.file.readOnly]}
            </div>
        );
    }
    return null;
}

function Notice({ children, action }: { children: ReactNode; action?: ReactNode }) {
    return (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-[11.5px] text-dark-200">
            {children}
            {action}
        </div>
    );
}

function OpenElsewhere({ cwd, path }: { cwd: string; path: string }) {
    return (
        <Button
            size="sm"
            onClick={() =>
                openFile(cwd, path).catch((error: unknown) =>
                    console.warn("[editor] open failed", error)
                )
            }
        >
            Open in default app
        </Button>
    );
}

/** The rendered Markdown of the tab's text, as zeron shows `.md` files. */
function MarkdownPreview({ id, version }: { id: string; version: number }) {
    // The editor isn't on screen meanwhile, so its text only changes from
    // disk, which bumps `version` and renders this again.
    void version;
    const text = currentState(id)?.doc.toString() ?? "";
    return (
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4 text-[13px]">
            <Markdown>{text}</Markdown>
        </div>
    );
}

function ImagePreview({ cwd, path, type }: { cwd: string; path: string; type: string }) {
    const [state, setState] = useState<{ url?: string; error?: string }>({});

    useEffect(() => {
        let url: string | undefined;
        let live = true;
        fileObjectUrl(cwd, path, type).then(
            (u) => {
                url = u;
                if (live) setState({ url: u });
                else URL.revokeObjectURL(u);
            },
            (error: unknown) =>
                live && setState({ error: error instanceof Error ? error.message : String(error) })
        );
        return () => {
            live = false;
            if (url) URL.revokeObjectURL(url);
        };
    }, [cwd, path, type]);

    if (state.error) return <Notice>{state.error}</Notice>;
    if (!state.url) return null;
    return (
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4">
            <img src={state.url} alt={path} className="max-h-full max-w-full object-contain" />
        </div>
    );
}
