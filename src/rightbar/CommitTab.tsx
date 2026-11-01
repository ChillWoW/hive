import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { parsePatch } from "@/diff/patch";
import { historyApi } from "@/history/api";
import { copyText } from "@/lib/clipboard";
import { errorMessage } from "@/lib/errors";
import type { GitDiff } from "@/proto";
import { Tooltip } from "@/ui";
import { ChangesSummary, FileList, ViewButtons } from "./FileChanges";
import { useFolds } from "./folds";
import { openPatchFile } from "./folders";
import { Loading, Notice, TabToolbar } from "./parts";
import type { RightTab } from "./store";

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

/**
 * What one commit changed (against its first parent), opened from the
 * history tab: its hash and subject in place of the scope menu, the same
 * file sections as the diff tab.
 */
export function CommitTab({ tab }: { tab: Extract<RightTab, { kind: "commit" }> }) {
    const { cwd, sha, subject } = tab;
    const [state, setState] = useState<{ diff?: GitDiff | null; error?: string }>({});

    useEffect(() => {
        let live = true;
        readCommit(cwd, sha).then(
            (diff) => live && setState({ diff }),
            (error) => live && setState({ error: errorMessage(error, "Git failed.") })
        );
        return () => {
            live = false;
        };
    }, [cwd, sha]);

    const diff = state.diff;
    const files = useMemo(() => parsePatch(diff?.patch ?? ""), [diff]);
    const folds = useFolds(files);
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
        content = <Loading label="Reading the commit" />;
    } else if (diff === null) {
        content = <Notice>This folder isn't in a git checkout any more.</Notice>;
    } else if (files.length === 0) {
        content = <Notice>Empty commit</Notice>;
    } else {
        const count = files.length;
        content = (
            <>
                <ChangesSummary
                    label={`${count} Changed ${count === 1 ? "file" : "files"} in this commit`}
                    files={files}
                    partial={diff.truncated ? "Partial" : undefined}
                />
                <FileList files={files} folds={folds} onOpen={open} />
            </>
        );
    }

    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <TabToolbar>
                <Tooltip>
                    <Tooltip.Trigger
                        render={
                            <button
                                type="button"
                                onClick={() => void copyText(sha)}
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
                <ViewButtons folds={folds} />
            </TabToolbar>
            {content}
        </div>
    );
}
