import { useEffect, useState, type ReactNode } from "react";
import {
    ArrowSquareOutIcon,
    CodeIcon,
    EyeIcon,
    LockSimpleIcon,
    TextAlignLeftIcon,
    WarningIcon
} from "@phosphor-icons/react";
import { ChatCwd } from "@/features/chat/transcript/context";
import { Markdown } from "@/features/chat/transcript/Markdown";
import { formatBytes } from "@/features/chats";
import { files } from "@/features/files/store";
import { panelTabs } from "@/features/panel-tabs/store";
import { isShortcutOf } from "@/keybindings";
import { getPanelLayout, useLayoutStore } from "@/layout/store";
import { cn } from "@/lib/cn";
import { errorMessage } from "@/lib/errors";
import { openFile } from "@/lib/files";
import type { ReadOnlyReason } from "@/proto";
import { Button, DotMatrixSpinner, FileIcon, FolderTreeIcon, IconButton, Tooltip } from "@/ui";
import { fileObjectUrl } from "./api";
import { CodeEditor } from "./CodeEditor";
import {
    currentState,
    isMarkdown,
    overwrite,
    reloadFromDisk,
    save,
    toggleWrap,
    togglePreview,
    unblockClose,
    useDocsStore,
    useEditorPrefs,
    type Doc
} from "./documents";

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
const imageType = (path: string) => IMAGE_TYPES[path.slice(path.lastIndexOf(".") + 1).toLowerCase()];

const READ_ONLY: Record<ReadOnlyReason, string> = {
    tooLarge: "Too large to edit here (over 1 MB).",
    binary: "A binary file; it can't be shown as text.",
    unsupportedEncoding: "Not UTF-8 text; it can't be shown here.",
    mixedLineEndings: "Mixed line endings: read-only, so saving can't change them.",
    symlink: "A link; Outcode doesn't follow links."
};

/** Opens the file in its default app. */
const openElsewhere = (cwd: string, path: string) =>
    openFile(`${cwd}/${path}`).catch((error: unknown) => console.warn("[editor] open failed", error));

/** Shows the file in the file panel, bringing the panel up if it's away. */
function revealInTree(cwd: string, path: string) {
    files.reveal(cwd, path);
    if (!getPanelLayout().visible.files) useLayoutStore.getState().toggle("files");
}

/** A file in the tabs panel: a toolbar over its editor, or its preview. */
export function FileTab({ id, cwd, path }: { id: string; cwd: string; path: string }) {
    const doc = useDocsStore((s) => s.docs[id]);
    const image = imageType(path);

    return (
        <div
            // The close-tab shortcut closes this tab while focus is in it (as a
            // terminal's does), not the chat's tab.
            onKeyDown={(event) => {
                if (!isShortcutOf(event.nativeEvent, "closeTab")) return;
                event.preventDefault();
                panelTabs.close(id);
            }}
            className="flex min-h-0 flex-1 flex-col"
        >
            <Toolbar id={id} cwd={cwd} path={path} doc={doc} image={!!image} />
            {doc && !image && <Banners id={id} doc={doc} />}
            {image ? (
                <ImagePreview cwd={cwd} path={path} type={image} />
            ) : !doc || doc.phase === "loading" ? (
                <div className="flex flex-1 items-center justify-center text-muted">
                    <DotMatrixSpinner label="Opening file" />
                </div>
            ) : doc.phase === "error" ? (
                <Notice icon={<WarningIcon className="size-5 text-warning" />}>{doc.error}</Notice>
            ) : doc.file?.text == null ? (
                <Notice
                    icon={<FileIcon name={path} className="size-6 opacity-70" />}
                    action={
                        <Button variant="outline" size="xs" onClick={() => void openElsewhere(cwd, path)}>
                            <ArrowSquareOutIcon />
                            Open in default app
                        </Button>
                    }
                >
                    {doc.file?.readOnly === "tooLarge"
                        ? `Too large to show here (${formatBytes(doc.file.size)}).`
                        : READ_ONLY[doc.file?.readOnly ?? "binary"]}
                </Notice>
            ) : isMarkdown(path) && doc.preview ? (
                <MarkdownPreview id={id} cwd={cwd} version={doc.version} />
            ) : (
                <CodeEditor key={id} id={id} />
            )}
        </div>
    );
}

function Toolbar({
    id,
    cwd,
    path,
    doc,
    image
}: {
    id: string;
    cwd: string;
    path: string;
    doc: Doc | undefined;
    image: boolean;
}) {
    const wrap = useEditorPrefs((s) => s.wrap);
    const slash = path.lastIndexOf("/");
    const folder = slash < 0 ? "" : path.slice(0, slash + 1);
    const name = path.slice(slash + 1);
    const text = !image && doc?.file?.text != null;
    const readOnly = text ? doc?.file?.readOnly : null;

    return (
        <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border pr-1.5 pl-3">
            <FileIcon name={name} className="mr-0.5 size-3.5" />
            <Tooltip>
                <Tooltip.Trigger
                    render={
                        <div className="flex min-w-0 flex-1 items-baseline text-xs">
                            {folder && <span className="min-w-0 truncate text-muted">{folder}</span>}
                            <span className="shrink-0 font-medium text-text">{name}</span>
                        </div>
                    }
                />
                <Tooltip.Content side="bottom">{path}</Tooltip.Content>
            </Tooltip>

            {doc?.saving && <span className="shrink-0 px-1 text-[11px] text-muted">Saving…</span>}
            {doc && <StatusLabel id={id} doc={doc} />}
            {readOnly && (
                <Tooltip>
                    <Tooltip.Trigger
                        render={
                            <span className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted">
                                <LockSimpleIcon className="size-3" />
                                Read-only
                            </span>
                        }
                    />
                    <Tooltip.Content side="bottom">{READ_ONLY[readOnly]}</Tooltip.Content>
                </Tooltip>
            )}

            <div className="flex shrink-0 items-center gap-0.5">
                {text && isMarkdown(path) && doc && (
                    <IconButton
                        label={doc.preview ? "Edit Markdown" : "Preview Markdown"}
                        onClick={() => togglePreview(id)}
                    >
                        {doc.preview ? <CodeIcon className="size-3.5" /> : <EyeIcon className="size-3.5" />}
                    </IconButton>
                )}
                {text && !(isMarkdown(path) && doc?.preview) && (
                    <IconButton
                        label={wrap ? "Don't wrap lines" : "Wrap lines"}
                        aria-pressed={wrap}
                        onClick={toggleWrap}
                        className={cn(wrap && "bg-hover text-text")}
                    >
                        <TextAlignLeftIcon className="size-3.5" />
                    </IconButton>
                )}
                <IconButton label="Show in file tree" onClick={() => revealInTree(cwd, path)}>
                    <FolderTreeIcon className="size-3.5" />
                </IconButton>
                <IconButton label="Open in default app" onClick={() => void openElsewhere(cwd, path)}>
                    <ArrowSquareOutIcon className="size-3.5" />
                </IconButton>
            </div>
        </div>
    );
}

/** Status words: only when something's wrong. */
function StatusLabel({ id, doc }: { id: string; doc: Doc }) {
    const status = doc.status;
    if (!status) return null;
    const [text, detail, tone] =
        status.kind === "saveFailed"
            ? ["Save failed", `${status.message} Click to try again.`, "text-danger"]
            : status.kind === "conflict"
              ? ["Save conflict", "The file changed on disk since it was opened.", "text-warning"]
              : status.kind === "changed"
                ? ["Changed on disk", "The file changed outside Outcode.", "text-warning"]
                : ["Deleted on disk", "The file is gone from disk.", "text-danger"];
    return (
        <Tooltip>
            <Tooltip.Trigger
                render={
                    <button
                        type="button"
                        onClick={() => status.kind === "saveFailed" && void save(id)}
                        className={cn(
                            "shrink-0 rounded-md px-1.5 py-0.5 text-[11px] outline-none hover:bg-hover",
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

function Banner({
    children,
    actions,
    tone = "warning"
}: {
    children: ReactNode;
    actions: ReactNode;
    tone?: "warning" | "danger";
}) {
    return (
        <div
            className={cn(
                "flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2 text-xs text-text",
                tone === "danger" ? "border-danger/25 bg-danger/8" : "border-warning/25 bg-warning/8"
            )}
        >
            <WarningIcon className={cn("size-3.5 shrink-0", tone === "danger" ? "text-danger" : "text-warning")} />
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
                tone="danger"
                actions={
                    <>
                        <Button variant="outline" size="xs" onClick={() => unblockClose(id)}>
                            Keep open
                        </Button>
                        <Button variant="destructive" size="xs" onClick={() => panelTabs.close(id, true)}>
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
                        <Button variant="outline" size="xs" onClick={() => void reloadFromDisk(id)}>
                            Reload from disk
                        </Button>
                        <Button variant="outline" size="xs" onClick={() => void overwrite(id)}>
                            Overwrite
                        </Button>
                    </>
                }
            >
                {doc.status.kind === "changed"
                    ? "This file changed outside Outcode."
                    : "This file changed on disk since it was opened, so it wasn't saved."}
            </Banner>
        );
    }
    if (doc.status?.kind === "deleted") {
        return (
            <Banner
                tone="danger"
                actions={
                    <Button variant="outline" size="xs" onClick={() => panelTabs.close(id, true)}>
                        Close tab
                    </Button>
                }
            >
                This file was deleted on disk.
            </Banner>
        );
    }
    return null;
}

function Notice({ children, icon, action }: { children: ReactNode; icon?: ReactNode; action?: ReactNode }) {
    return (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-xs text-muted">
            {icon}
            <p className="max-w-64">{children}</p>
            {action}
        </div>
    );
}

/** The rendered Markdown of the tab's text. */
function MarkdownPreview({ id, cwd, version }: { id: string; cwd: string; version: number }) {
    // The editor isn't on screen meanwhile, so its text only changes from
    // disk, which bumps `version` and renders this again.
    void version;
    const text = currentState(id)?.doc.toString() ?? "";
    return (
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 py-5 text-[13px]">
            <ChatCwd value={cwd}>
                <Markdown>{text}</Markdown>
            </ChatCwd>
        </div>
    );
}

/** An image, fit to the panel over a checkerboard (for transparency), with its size below. */
function ImagePreview({ cwd, path, type }: { cwd: string; path: string; type: string }) {
    const [state, setState] = useState<{ url?: string; error?: string }>({});
    const [size, setSize] = useState<{ width: number; height: number } | null>(null);

    useEffect(() => {
        let url: string | undefined;
        let live = true;
        fileObjectUrl(cwd, path, type).then(
            (u) => {
                url = u;
                if (live) setState({ url: u });
                else URL.revokeObjectURL(u);
            },
            (error: unknown) => live && setState({ error: errorMessage(error) })
        );
        return () => {
            live = false;
            if (url) URL.revokeObjectURL(url);
        };
    }, [cwd, path, type]);

    if (state.error) return <Notice icon={<WarningIcon className="size-5 text-warning" />}>{state.error}</Notice>;
    if (!state.url) return null;
    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-6">
                <img
                    src={state.url}
                    alt={path}
                    onLoad={(event) =>
                        setSize({
                            width: event.currentTarget.naturalWidth,
                            height: event.currentTarget.naturalHeight
                        })
                    }
                    className="checkerboard max-h-full max-w-full rounded-sm object-contain shadow-sm shadow-shadow/20"
                />
            </div>
            {size && (
                <div className="shrink-0 pb-3 text-center text-[11px] text-muted tabular-nums">
                    {size.width} × {size.height}
                </div>
            )}
        </div>
    );
}
