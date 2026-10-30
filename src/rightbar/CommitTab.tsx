import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
    ArrowsInLineVerticalIcon,
    ArrowsOutLineVerticalIcon,
    ColumnsIcon,
    TextAlignLeftIcon
} from "@phosphor-icons/react";
import { FileSection } from "@/diff/DiffFiles";
import { parsePatch, totals, type FileDiff } from "@/diff/patch";
import { useDiffPrefs } from "@/diff/store";
import { errorText } from "@/git/store";
import { historyApi } from "@/history/api";
import { cn } from "@/lib/cn";
import type { GitDiff } from "@/proto";
import { DotMatrixSpinner, Tooltip } from "@/ui";
import { openPatchFile } from "./folders";
import type { RightTab } from "./store";
import { ToolButton } from "./ToolButton";

type CommitTabData = Extract<RightTab, { kind: "commit" }>;

/** Read commits, by folder and hash: a commit never changes. */
const cache = new Map<string, Promise<GitDiff | null>>();

function readCommit(cwd: string, sha: string) {
    const key = `${cwd}\0${sha}`;
    let request = cache.get(key);
    if (!request) {
        request = historyApi.commitDiff(cwd, sha);
        // A failure is tried again next time.
        request.catch(() => cache.delete(key));
        cache.set(key, request);
    }
    return request;
}

type State = { diff?: GitDiff | null; error?: string };

/**
 * What one commit changed (against its first parent), opened from the
 * history tab, as zeron's commit-pinned Diff surface: its hash and subject in
 * place of the scope menu, the same file sections as the diff tab.
 */
export function CommitTab({ tab }: { tab: CommitTabData }) {
    const { cwd, sha, subject } = tab;
    const { split, wrap, toggleSplit, toggleWrap } = useDiffPrefs();
    const [state, setState] = useState<State>({});

    useEffect(() => {
        let live = true;
        readCommit(cwd, sha).then(
            (diff) => live && setState({ diff }),
            (error) => live && setState({ error: errorText(error) })
        );
        return () => {
            live = false;
        };
    }, [cwd, sha]);

    const diff = state.diff;
    const files = useMemo(() => parsePatch(diff?.patch ?? ""), [diff]);
    const sum = useMemo(() => totals(files), [files]);

    const [folds, setFolds] = useState<Record<string, boolean>>({});
    const isFolded = (file: FileDiff) => folds[file.path] ?? true;
    const allFolded = files.length > 0 && files.every(isFolded);
    const toggle = useCallback(
        (path: string, folded: boolean) => setFolds((s) => ({ ...s, [path]: !folded })),
        []
    );
    const root = diff?.root;
    const open = useCallback(
        (path: string) => {
            if (root) openPatchFile(cwd, root, path);
        },
        [cwd, root]
    );

    let content: ReactNode;
    if (state.error) {
        content = <Notice tone="warning">{state.error}</Notice>;
    } else if (diff === undefined) {
        content = (
            <div className="flex flex-1 items-center justify-center">
                <DotMatrixSpinner label="Reading the commit" />
            </div>
        );
    } else if (diff === null) {
        content = <Notice>This folder isn't in a git checkout any more.</Notice>;
    } else if (files.length === 0) {
        content = <Notice>Empty commit</Notice>;
    } else {
        content = (
            <>
                <div className="flex h-8 shrink-0 items-center gap-2.5 border-b border-dark-600 px-4 text-[11.5px]">
                    <span className="min-w-0 truncate text-dark-200">
                        {sum.files} Changed {sum.files === 1 ? "file" : "files"} in this commit
                    </span>
                    <span className="text-[11px] tabular-nums text-[#34d399]">+{sum.additions}</span>
                    <span className="text-[11px] tabular-nums text-[#f87171]">−{sum.deletions}</span>
                    <span className="flex-1" />
                    {diff.truncated && (
                        <Tooltip>
                            <Tooltip.Trigger
                                render={
                                    <span className="shrink-0 rounded bg-warning/10 px-1.5 py-0.5 text-[10px] text-warning/80">
                                        Partial
                                    </span>
                                }
                            />
                            <Tooltip.Content side="bottom">
                                Too large to show whole; some changes are left out.
                            </Tooltip.Content>
                        </Tooltip>
                    )}
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
                    {files.map((file, i) => (
                        <FileSection
                            key={file.path}
                            file={file}
                            first={i === 0}
                            folded={isFolded(file)}
                            split={split}
                            wrap={wrap}
                            onToggle={toggle}
                            onOpen={file.status === "deleted" ? undefined : open}
                        />
                    ))}
                </div>
            </>
        );
    }

    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex h-9 shrink-0 items-center gap-1 border-b border-dark-600 px-2">
                <Tooltip>
                    <Tooltip.Trigger
                        render={
                            <button
                                type="button"
                                onClick={() => void navigator.clipboard.writeText(sha)}
                                className="flex h-6 shrink-0 items-center rounded-md bg-white/[0.05] px-1.5 font-mono text-[10.5px] text-dark-100 outline-none transition-colors hover:bg-white/10 focus-visible:bg-white/10"
                            >
                                {sha.slice(0, 7)}
                            </button>
                        }
                    />
                    <Tooltip.Content side="bottom">Copy the full hash</Tooltip.Content>
                </Tooltip>
                <span className="ml-1 min-w-0 flex-1 truncate text-[12px] text-dark-50">
                    {subject || "(no subject)"}
                </span>
                <ToolButton
                    label={split ? "Unified view" : "Split view"}
                    pressed={split}
                    onClick={toggleSplit}
                >
                    <ColumnsIcon className="size-3.5" />
                </ToolButton>
                <ToolButton label={wrap ? "Don't wrap lines" : "Wrap lines"} pressed={wrap} onClick={toggleWrap}>
                    <TextAlignLeftIcon className="size-3.5" />
                </ToolButton>
                <ToolButton
                    label={allFolded ? "Expand all" : "Collapse all"}
                    disabled={files.length === 0}
                    onClick={() =>
                        setFolds(Object.fromEntries(files.map((f) => [f.path, !allFolded])))
                    }
                >
                    {allFolded ? (
                        <ArrowsOutLineVerticalIcon className="size-3.5" />
                    ) : (
                        <ArrowsInLineVerticalIcon className="size-3.5" />
                    )}
                </ToolButton>
            </div>
            {content}
        </div>
    );
}

function Notice({ children, tone }: { children: ReactNode; tone?: "warning" }) {
    return (
        <div
            className={cn(
                "flex flex-1 items-center justify-center p-6 text-center text-xs",
                tone === "warning" ? "text-warning/85" : "text-dark-250"
            )}
        >
            {children}
        </div>
    );
}
