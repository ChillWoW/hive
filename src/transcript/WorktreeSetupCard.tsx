import { useState, type ReactNode } from "react";
import { Collapsible } from "@base-ui/react/collapsible";
import {
    CheckIcon,
    CircleIcon,
    CircleNotchIcon,
    CopyIcon,
    FolderOpenIcon,
    GitBranchIcon,
    TerminalWindowIcon,
    XCircleIcon
} from "@phosphor-icons/react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import type { SetupStage, SetupStatus, WorktreeSetup } from "@/chats";
import { copyText } from "@/lib/clipboard";
import { cn } from "@/lib/cn";
import { isTauri, REVEAL_LABEL } from "@/lib/platform";
import type { Worktree } from "@/proto";
import { openTerminalTab } from "@/rightbar";
import { useNow } from "@/lib/time";
import { lineClassName, panelTransition, targetClassName, verbClassName } from "./line";
import { FoldHeader, LineIcon } from "./ToolGroup";
import type { ToolIcon } from "./tools";

const STAGE_LABELS: Record<SetupStage["id"], string> = {
    name: "Name branch",
    checkout: "Create worktree",
    agent: "Start agent"
};

/** `0.4s`, `12s`, `1m 05s`. */
function formatDuration(ms: number) {
    const s = ms / 1000;
    if (s < 10) return `${s.toFixed(1)}s`;
    if (s < 60) return `${Math.round(s)}s`;
    const m = Math.floor(s / 60);
    return `${m}m ${String(Math.round(s % 60)).padStart(2, "0")}s`;
}

const Spinner: ToolIcon = ({ className }) => (
    <CircleNotchIcon weight="bold" className={cn(className, "animate-spin")} />
);
const Pending: ToolIcon = ({ className }) => <CircleIcon className={cn(className, "opacity-40")} />;

const STATUS_ICONS: Record<SetupStatus, ToolIcon> = {
    pending: Pending,
    running: Spinner,
    done: CheckIcon,
    failed: XCircleIcon
};

function BranchName({ branch }: { branch: string }) {
    return (
        <span className={cn(targetClassName, "flex items-center gap-1.5")}>
            <GitBranchIcon className="size-[13px] shrink-0" />
            <span className="min-w-0 truncate font-mono text-xs">{branch}</span>
        </span>
    );
}

function StageRow({ stage, now, agent }: { stage: SetupStage; now: number; agent?: string }) {
    const running = stage.status === "running";
    const failed = stage.status === "failed";
    const elapsed =
        stage.startedAt !== undefined ? (stage.endedAt ?? now) - stage.startedAt : undefined;
    return (
        <div className={lineClassName}>
            <LineIcon icon={STATUS_ICONS[stage.status]} failed={failed} />
            <span
                className={cn(
                    verbClassName,
                    failed && "text-danger",
                    stage.status === "pending" && "opacity-50",
                    running && "shimmer"
                )}
            >
                {STAGE_LABELS[stage.id]}
            </span>
            {stage.branch && stage.status !== "pending" ? (
                <BranchName branch={stage.branch} />
            ) : (
                stage.id === "agent" &&
                agent &&
                stage.status !== "pending" && <span className={targetClassName}>{agent}</span>
            )}
            {elapsed !== undefined && stage.status !== "pending" && (
                <span className="ml-auto shrink-0 pl-3 text-xs text-dark-300 tabular-nums">
                    {formatDuration(elapsed)}
                </span>
            )}
        </div>
    );
}

function ActionButton({
    icon,
    children,
    disabled,
    onClick
}: {
    icon: ReactNode;
    children: ReactNode;
    disabled?: boolean;
    onClick: () => void;
}) {
    return (
        <button
            type="button"
            disabled={disabled}
            onClick={onClick}
            className="flex h-6 items-center gap-1.5 rounded-md px-2 text-xs text-dark-200 transition-colors hover:bg-white/[0.06] hover:text-dark-50 disabled:pointer-events-none disabled:opacity-40"
        >
            {icon}
            {children}
        </button>
    );
}

/** Where the worktree is, and what to do with it. */
function Details({ worktree }: { worktree: Worktree }) {
    return (
        <div className="flex flex-col gap-2 pt-1 pb-1 pl-[22px]">
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
                <dt className="text-dark-250">Branch</dt>
                <dd className="truncate font-mono text-[11px] leading-4 text-dark-100">{worktree.branch}</dd>
                <dt className="text-dark-250">Base</dt>
                <dd className="truncate font-mono text-[11px] leading-4 text-dark-100">{worktree.base}</dd>
                <dt className="text-dark-250">Folder</dt>
                <dd className="truncate font-mono text-[11px] leading-4 text-dark-100" title={worktree.root}>
                    {worktree.root}
                </dd>
            </dl>
            <div className="-ml-2 flex flex-wrap items-center gap-0.5">
                <ActionButton
                    icon={<TerminalWindowIcon className="size-3.5" />}
                    onClick={() => openTerminalTab(worktree.path)}
                >
                    Open terminal
                </ActionButton>
                <ActionButton
                    icon={<FolderOpenIcon className="size-3.5" />}
                    disabled={!isTauri}
                    onClick={() => void revealItemInDir(worktree.path).catch(() => {})}
                >
                    {REVEAL_LABEL}
                </ActionButton>
                <ActionButton icon={<CopyIcon className="size-3.5" />} onClick={() => void copyText(worktree.path)}>
                    Copy path
                </ActionButton>
            </div>
        </div>
    );
}

/**
 * A new chat's worktree being made, under its first prompt (drawn
 * like a tool group): a shimmering "Setting up
 * worktree" with a rail of steps — naming the branch, checking it out, the
 * agent starting — each with its time, open while it runs. Once the agent
 * answers it folds to "Worktree ready" and its branch; opened, the steps,
 * where it is and a terminal or file manager there. A failed setup stays
 * open with why. Without `setup` (made before a reload) only the worktree.
 */
export function WorktreeSetupCard({
    setup,
    worktree,
    agent
}: {
    setup?: WorktreeSetup;
    worktree?: Worktree;
    agent?: string;
}) {
    const running = !!setup && !setup.endedAt;
    const failed = !!setup?.error;
    const now = useNow(running, 100);
    const made = setup?.worktree ?? worktree;
    const [userOpen, setUserOpen] = useState<boolean>();
    const open = userOpen ?? (running || failed);

    if (!setup && !made) return null;

    const label = running
        ? "Setting up worktree"
        : failed
          ? made
              ? "Worktree ready, agent didn't start"
              : "Worktree setup failed"
          : "Worktree ready";
    const total = setup && (setup.endedAt ?? now) - setup.startedAt;

    return (
        <Collapsible.Root open={open} onOpenChange={setUserOpen}>
            <FoldHeader className="min-w-0">
                <span className={cn("shrink-0", failed && "text-danger", running && "shimmer")}>
                    {label}
                </span>
                {!running && made && (
                    <span className="min-w-0 truncate text-dark-250">
                        · <span className="font-mono text-[11px]">{made.branch}</span> from {made.base}
                    </span>
                )}
                {total !== undefined && (
                    <span className="shrink-0 text-[11px] text-dark-250 tabular-nums">
                        · {formatDuration(total)}
                    </span>
                )}
            </FoldHeader>
            <Collapsible.Panel className={panelTransition}>
                <div className="flex flex-col pt-1">
                    {setup?.stages.map((stage) => (
                        <StageRow key={stage.id} stage={stage} now={now} agent={agent} />
                    ))}
                    {setup?.error && (
                        <p className="pt-0.5 pb-1 pl-[22px] text-xs break-words whitespace-pre-wrap text-danger">
                            {setup.error}
                        </p>
                    )}
                    {made && !running && <Details worktree={made} />}
                </div>
            </Collapsible.Panel>
        </Collapsible.Root>
    );
}
