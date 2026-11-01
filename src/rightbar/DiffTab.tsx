import { useCallback, useMemo, useState, type ReactNode } from "react";
import { ArrowCounterClockwiseIcon, ArrowRightIcon, CaretDownIcon, CheckIcon } from "@phosphor-icons/react";
import { isBusy, useChatsStore } from "@/chats";
import { useCommenting } from "@/diff/commenting";
import { CommentingProvider } from "@/diff/comments";
import { parsePatchReusing, type FileDiff } from "@/diff/patch";
import { RevertTurnDialog, type RevertRequest } from "@/diff/RevertTurnDialog";
import { SCOPE_LABELS, useCheckoutDiff, useDiffPrefs, useTurnDiff, type DiffScope } from "@/diff/store";
import { useGitRepo } from "@/git";
import { cn } from "@/lib/cn";
import type { GitRepo } from "@/proto";
import { usePanelLayout } from "@/stores/useLayoutStore";
import { Menu, Tooltip } from "@/ui";
import { ChangesSummary, FileList, ViewButtons } from "./FileChanges";
import { useFolds } from "./folds";
import { openPatchFile, useActiveFolder } from "./folders";
import { Loading, Notice, TabToolbar } from "./parts";

/**
 * The diff tab: the open chat's checkout against
 * HEAD (untracked files included), a branch's changes against another, or
 * what the chat's latest turn changed; unified or split, per-file folding,
 * read again while it's shown.
 */
export function DiffTab() {
    const folder = useActiveFolder();
    // Folds belong to one folder's files.
    return <DiffPane key={folder ?? ""} folder={folder} />;
}

/** What branch changes are compared with: the saved pick, else main / master, else the newest. */
function pickBase(repo: GitRepo, saved: string | undefined) {
    const names = repo.branches.filter((b) => !b.current).map((b) => b.name);
    if (saved && names.includes(saved)) return saved;
    return ["main", "master", "develop", "trunk"].find((n) => names.includes(n)) ?? names[0];
}

function scopeLabel(scope: DiffScope, count: number, base: string | undefined) {
    const files = count === 1 ? "file" : "files";
    if (scope === "workingTree") {
        return count === 1 ? "1 Uncommitted change" : `${count} Uncommitted changes`;
    }
    if (scope === "turn") return `${count} Changed ${files} this turn`;
    return base ? `${count} Changed ${files} vs ${base}` : `${count} Changed ${files}`;
}

function emptyLabel(scope: DiffScope, base: string | undefined) {
    if (scope === "workingTree") return "No uncommitted changes";
    if (scope === "turn") return "No changes this turn";
    return base ? `No changes vs ${base}` : "No branch changes";
}

/** The last shown patch's files by section, so a refresh reuses the unchanged ones. */
let lastSections = new Map<string, FileDiff>();
function parseShown(patch: string) {
    const parsed = parsePatchReusing(patch, lastSections);
    lastSections = parsed.sections;
    return parsed.files;
}

function DiffPane({ folder }: { folder: string | null }) {
    const { scope, bases, setScope, setBase } = useDiffPrefs();
    const repoEntry = useGitRepo(folder);
    const repo = repoEntry?.repo;
    const base = scope === "branch" && repo ? pickBase(repo, bases[repo.root]) : undefined;
    const waitingForBase = scope === "branch" && !base;
    // Not read while the right sidebar is closed (it stays mounted).
    const shown = usePanelLayout().visible.right;
    const turnScope = scope === "turn";
    // The open chat's latest turn; the new-chat view has none.
    const chatId = useChatsStore((s) => s.activeChatId);
    const checkoutEntry = useCheckoutDiff(folder, base, shown && !waitingForBase && !turnScope);
    const turnEntry = useTurnDiff(folder, chatId, shown && turnScope);
    const entry = turnScope ? turnEntry : checkoutEntry;
    const diff = entry?.diff;

    const patch = diff?.patch ?? "";
    const files = useMemo(() => parseShown(patch), [patch]);
    const folds = useFolds(files);

    const root = diff?.root;
    const commenting = useCommenting(chatId, folder, root);

    // Undoing the turn: never while it's still running.
    const [revert, setRevert] = useState<RevertRequest | null>(null);
    const chatBusy = useChatsStore((s) => isBusy(chatId ? s.sessions[chatId]?.status : undefined));
    const canRevert = turnScope && !!chatId && !!folder && !chatBusy && !diff?.truncated;
    const revertFiles = useCallback(
        (picked: FileDiff[], whole: boolean) => {
            if (chatId && folder) setRevert({ chatId, cwd: folder, files: picked, whole });
        },
        [chatId, folder]
    );
    const revertFile = useCallback((file: FileDiff) => revertFiles([file], false), [revertFiles]);
    const open = useCallback(
        (path: string) => {
            if (root && folder) openPatchFile(folder, root, path);
        },
        [root, folder]
    );

    let content: ReactNode;
    if (!folder) {
        content = <Notice>Open a chat, or pick a folder for a new one, to see its changes.</Notice>;
    } else if (repoEntry && repo === null) {
        content = <Notice>This folder isn't in a git checkout.</Notice>;
    } else if (scope === "branch" && repo && !base) {
        content = <Notice>There's no other branch to compare this one with.</Notice>;
    } else if (turnScope && (!chatId || diff === null)) {
        content = <Notice>No turn recorded yet — send a message first.</Notice>;
    } else if (!entry || (scope === "branch" && !repo)) {
        content = <Loading label="Reading changes" />;
    } else if (diff === null) {
        content = <Notice>This folder isn't in a git checkout.</Notice>;
    } else if (!diff) {
        content = <Notice tone="warning">{entry.error ?? "Git failed."}</Notice>;
    } else if (files.length === 0) {
        content = <Notice>{emptyLabel(scope, base)}</Notice>;
    } else {
        content = (
            <>
                <ChangesSummary
                    label={scopeLabel(scope, files.length, base)}
                    files={files}
                    partial={diff.truncated ? "Partial snapshot" : undefined}
                >
                    {turnScope && (
                        <Tooltip>
                            <Tooltip.Trigger
                                render={
                                    <button
                                        type="button"
                                        disabled={!canRevert}
                                        onClick={() => revertFiles(files, true)}
                                        className={cn(
                                            "flex h-6 shrink-0 items-center gap-1.5 rounded-md px-2 text-[11.5px] text-dark-100",
                                            "transition-colors hover:bg-white/10 hover:text-dark-50 disabled:pointer-events-none disabled:opacity-50"
                                        )}
                                    >
                                        <ArrowCounterClockwiseIcon className="size-3.5" />
                                        Undo turn
                                    </button>
                                }
                            />
                            <Tooltip.Content side="bottom">
                                {chatBusy
                                    ? "Wait for the turn to finish"
                                    : diff.truncated
                                      ? "Too large to undo from here"
                                      : "Put every file back as the turn found it"}
                            </Tooltip.Content>
                        </Tooltip>
                    )}
                </ChangesSummary>
                <CommentingProvider value={commenting}>
                    <FileList
                        files={files}
                        folds={folds}
                        onOpen={open}
                        onRevert={canRevert ? revertFile : undefined}
                    />
                </CommentingProvider>
            </>
        );
    }

    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <TabToolbar>
                <ScopeMenu scope={scope} onChange={setScope} />
                {scope === "branch" && repo && base && (
                    <BaseStrip
                        repo={repo}
                        branch={diff?.branch ?? repo.branch ?? "HEAD"}
                        base={base}
                        onChange={(name) => setBase(repo.root, name)}
                    />
                )}
                <span className="flex-1" />
                <ViewButtons folds={folds} />
            </TabToolbar>
            {entry?.error && diff && (
                <div className="shrink-0 border-b border-dark-600 px-3 py-1 text-[11px] text-warning">
                    {entry.error}
                </div>
            )}
            {content}
            <RevertTurnDialog request={revert} onClose={() => setRevert(null)} />
        </div>
    );
}

const triggerClassName = cn(
    "flex h-6 min-w-0 items-center gap-1.5 rounded-md px-2 text-[11.5px] outline-none",
    "transition-colors hover:bg-white/10 focus-visible:bg-white/10 data-[popup-open]:bg-white/10"
);

function ScopeMenu({ scope, onChange }: { scope: DiffScope; onChange: (scope: DiffScope) => void }) {
    return (
        <Menu>
            <Menu.Trigger className={cn(triggerClassName, "shrink-0 bg-white/[0.05] text-dark-50")}>
                {SCOPE_LABELS[scope]}
                <CaretDownIcon className="size-3 text-dark-200" />
            </Menu.Trigger>
            <Menu.Content side="bottom" align="start" sideOffset={6} className="w-44 min-w-0">
                {(Object.keys(SCOPE_LABELS) as DiffScope[]).map((s) => (
                    <Menu.Item key={s} onClick={() => onChange(s)}>
                        <span className="flex-1">{SCOPE_LABELS[s]}</span>
                        {s === scope && <CheckIcon className="size-3" weight="bold" />}
                    </Menu.Item>
                ))}
            </Menu.Content>
        </Menu>
    );
}

/** `{branch} → {base ⌄}`: what the branch's changes are compared with. */
function BaseStrip({
    repo,
    branch,
    base,
    onChange
}: {
    repo: GitRepo;
    branch: string;
    base: string;
    onChange: (name: string) => void;
}) {
    const others = repo.branches.filter((b) => !b.current);
    return (
        <div className="ml-1 flex min-w-0 items-center gap-1.5 font-mono text-[11.5px]">
            <span className="min-w-0 truncate text-dark-200">{branch}</span>
            <ArrowRightIcon className="size-3 shrink-0 text-dark-250" />
            <Menu>
                <Menu.Trigger className={cn(triggerClassName, "px-1.5 text-dark-50")}>
                    <span className="min-w-0 truncate">{base}</span>
                    <CaretDownIcon className="size-3 shrink-0 text-dark-200" />
                </Menu.Trigger>
                <Menu.Content side="bottom" align="start" sideOffset={6} className="max-h-72 w-60 min-w-0">
                    {others.map((b) => (
                        <Menu.Item key={b.name} onClick={() => onChange(b.name)}>
                            <span className="min-w-0 flex-1 truncate font-mono">{b.name}</span>
                            {b.name === base && <CheckIcon className="size-3 shrink-0" weight="bold" />}
                        </Menu.Item>
                    ))}
                </Menu.Content>
            </Menu>
        </div>
    );
}
