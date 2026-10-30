import { useCallback, useMemo, useState, type ReactNode } from "react";
import {
    ArrowRightIcon,
    ArrowsInLineVerticalIcon,
    ArrowsOutLineVerticalIcon,
    CaretDownIcon,
    CheckIcon,
    ColumnsIcon,
    TextAlignLeftIcon
} from "@phosphor-icons/react";
import { useChatsStore } from "@/chats";
import { FileSection } from "@/diff/DiffFiles";
import { parsePatchReusing, totals, type FileDiff } from "@/diff/patch";
import { SCOPE_LABELS, useCheckoutDiff, useDiffPrefs, useTurnDiff, type DiffScope } from "@/diff/store";
import { useGitRepo } from "@/git";
import { cn } from "@/lib/cn";
import type { GitRepo } from "@/proto";
import { usePanelLayout } from "@/stores/useLayoutStore";
import { DotMatrixSpinner, Menu, Tooltip } from "@/ui";
import { openPatchFile, useActiveFolder } from "./folders";
import { ToolButton } from "./ToolButton";

/**
 * The diff tab, as zeron's Diff surface: the open chat's checkout against
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

/** The last shown patch's files by section, so a refresh reuses the unchanged ones. */
let lastSections = new Map<string, FileDiff>();
function parseShown(patch: string) {
    const parsed = parsePatchReusing(patch, lastSections);
    lastSections = parsed.sections;
    return parsed.files;
}

function DiffPane({ folder }: { folder: string | null }) {
    const { scope, split, wrap, bases, setScope, toggleSplit, toggleWrap, setBase } =
        useDiffPrefs();
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
        content = (
            <div className="flex flex-1 items-center justify-center">
                <DotMatrixSpinner label="Reading changes" />
            </div>
        );
    } else if (diff === null) {
        content = <Notice>This folder isn't in a git checkout.</Notice>;
    } else if (!diff) {
        content = <Notice tone="warning">{entry.error ?? "Git failed."}</Notice>;
    } else if (files.length === 0) {
        content = (
            <Notice>
                {scope === "workingTree"
                    ? "No uncommitted changes"
                    : turnScope
                      ? "No changes this turn"
                      : base
                      ? `No changes vs ${base}`
                      : "No branch changes"}
            </Notice>
        );
    } else {
        content = (
            <>
                <div className="flex h-8 shrink-0 items-center gap-2.5 border-b border-dark-600 px-4 text-[11.5px]">
                    <span className="min-w-0 truncate text-dark-200">
                        {scopeLabel(scope, sum.files, base)}
                    </span>
                    <span className="text-[11px] tabular-nums text-[#34d399]">+{sum.additions}</span>
                    <span className="text-[11px] tabular-nums text-[#f87171]">−{sum.deletions}</span>
                    <span className="flex-1" />
                    {diff.truncated && (
                        <Tooltip>
                            <Tooltip.Trigger
                                render={
                                    <span className="shrink-0 rounded bg-warning/10 px-1.5 py-0.5 text-[10px] text-warning/80">
                                        Partial snapshot
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
            {entry?.error && diff && (
                <div className="shrink-0 border-b border-dark-600 px-3 py-1 text-[11px] text-warning">
                    {entry.error}
                </div>
            )}
            {content}
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

/** `{branch} → {base ⌄}`: what the branch's changes are compared with, as in zeron. */
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
            <ArrowRightIcon className="size-3 shrink-0 text-dark-300" />
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
