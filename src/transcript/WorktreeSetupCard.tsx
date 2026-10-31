import { useEffect, useState, type ReactNode } from "react";
import { Collapsible } from "@base-ui/react/collapsible";
import {
    CaretDownIcon,
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
import { cn } from "@/lib/cn";
import { isTauri, platform } from "@/lib/platform";
import type { Worktree } from "@/proto";
import { openTerminalTab } from "@/rightbar";
import { panelTransition, Rail } from "./ToolGroup";
import type { ToolIcon } from "./tools";

const STAGE_LABELS: Record<SetupStage["id"], string> = {
    name: "Name branch",
    checkout: "Create worktree",
    agent: "Start agent"
};

const REVEAL_LABEL =
    platform === "macos"
        ? "Reveal in Finder"
        : platform === "windows"
          ? "Show in Explorer"
          : "Show in folder";

/** `0.4s`, `12s`, `1m 05s`. */
function formatDuration(ms: number) {
    const s = ms / 1000;
    if (s < 10) return `${s.toFixed(1)}s`;
    if (s < 60) return `${Math.round(s)}s`;
    const m = Math.floor(s / 60);
    return `${m}m ${String(Math.round(s % 60)).padStart(2, "0")}s`;
}

/** Now, re-read every `ms` while `live`. */
function useNow(live: boolean, ms = 100) {
    const [now, setNow] = useState(Date.now);
    useEffect(() => {
        if (!live) return;
        const id = setInterval(() => setNow(Date.now()), ms);
        return () => clearInterval(id);
    }, [live, ms]);
    return live ? now : Date.now();
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

function BranchBadge({ branch }: { branch: string }) {
    return (
        <span className="flex h-[22px] min-w-0 items-center gap-1.5 rounded-[5px] bg-white/[0.06] pr-1.5 pl-px text-dark-100">
            <span className="flex size-5 shrink-0 items-center justify-center rounded-[4px] bg-white/[0.05]">
                <GitBranchIcon className="size-3.5" />
            </span>
            <span className="min-w-0 truncate font-mono text-[11px]">{branch}</span>
        </span>
    );
}

function StageRow({
    stage,
    last,
    now,
    agent
}: {
    stage: SetupStage;
    last: boolean;
    now: number;
    agent?: string;
}) {
    const running = stage.status === "running";
    const failed = stage.status === "failed";
    const elapsed =
        stage.startedAt !== undefined ? (stage.endedAt ?? now) - stage.startedAt : undefined;
    return (
        <div className="flex h-8 min-w-0 items-center gap-2 text-xs">
            <Rail icon={STATUS_ICONS[stage.status]} failed={failed} last={last} />
            <span
                className={cn(
                    "shrink-0",
                    failed ? "text-danger" : "text-dark-200",
                    stage.status === "pending" && "opacity-50",
                    running && "shimmer"
                )}
            >
                {STAGE_LABELS[stage.id]}
            </span>
            {stage.branch && stage.status !== "pending" ? (
                <BranchBadge branch={stage.branch} />
            ) : (
                stage.id === "agent" &&
                agent &&
                stage.status !== "pending" && (
                    <span className="min-w-0 truncate text-dark-250">{agent}</span>
                )
            )}
            {elapsed !== undefined && stage.status !== "pending" && (
                <span className="ml-auto shrink-0 pr-1 text-[11px] text-dark-250 tabular-nums">
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

const copy = (text: string) => void navigator.clipboard.writeText(text).catch(() => {});

/** Where the worktree is, and what to do with it. */
function Details({ worktree }: { worktree: Worktree }) {
    return (
        <div className="flex flex-col gap-2 pt-1 pb-1 pl-12">
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
                <ActionButton icon={<CopyIcon className="size-3.5" />} onClick={() => copy(worktree.path)}>
                    Copy path
                </ActionButton>
            </div>
        </div>
    );
}

/**
 * A new chat's worktree being made, under its first prompt (as t3code's
 * worktree setup card, drawn like a tool group): a shimmering "Setting up
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
    const now = useNow(running);
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
            <Collapsible.Trigger className="group/header flex h-[26px] max-w-full min-w-0 items-center gap-1.5 pr-1 text-left text-xs text-dark-200 transition-colors hover:text-dark-50">
                <span className="relative h-[18px] w-[22px] shrink-0">
                    <CaretDownIcon
                        weight="bold"
                        className="absolute top-0.5 left-[5.5px] size-3.5 -rotate-90 transition-transform duration-200 group-data-panel-open/header:rotate-0"
                    />
                </span>
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
            </Collapsible.Trigger>
            <Collapsible.Panel className={panelTransition}>
                <div className="flex flex-col pt-0.5">
                    {setup?.stages.map((stage, i) => (
                        <StageRow
                            key={stage.id}
                            stage={stage}
                            last={i === setup.stages.length - 1}
                            now={now}
                            agent={agent}
                        />
                    ))}
                    {setup?.error && (
                        <p className="pt-0.5 pb-1 pl-12 text-xs break-words whitespace-pre-wrap text-danger">
                            {setup.error}
                        </p>
                    )}
                    {made && !running && <Details worktree={made} />}
                </div>
            </Collapsible.Panel>
        </Collapsible.Root>
    );
}
