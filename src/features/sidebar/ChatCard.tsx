import type { ReactNode } from "react";
import { GitForkIcon } from "@phosphor-icons/react";
import { activity } from "@/features/chats";
import {
    ClaudeMark,
    isFastMode,
    REASONING_LABELS,
    resolveModel,
    resolveReasoning,
    useCatalog
} from "@/features/models";
import { ProjectIcon } from "@/features/projects";
import { baseName } from "@/lib/paths";
import { agoLabel, useMinuteClock } from "@/lib/time";
import type { Chat } from "@/proto";
import { STATUS } from "./status";
import { StatusMark } from "./StatusMark";

/**
 * What a sidebar row has no room for, shown in its hover card: the whole
 * title and its age, then the folder it works in (and its worktree's
 * branch), its model and whether it's working.
 */
export function ChatCard({ chat, title, working }: { chat: Chat; title: string; working: boolean }) {
    const now = useMinuteClock();
    const catalog = useCatalog();
    const model = resolveModel(catalog, chat.config);
    const reasoning = resolveReasoning(model, chat.config);
    const fast = isFastMode(model, chat.config);
    return (
        <div className="flex flex-col gap-2.5">
            <div className="flex flex-col gap-0.5">
                <p className="text-[13px] leading-snug font-medium break-words text-text">{title}</p>
                <p className="text-[11px] text-muted/75">{agoLabel(activity(chat), now)}</p>
            </div>

            <div className="flex flex-col gap-1.5 border-t border-border pt-2.5">
                <Meta icon={<ProjectIcon path={chat.cwd} className="size-3.5" />}>
                    <span className="text-text/85">{baseName(chat.cwd)}</span>
                    <span className="text-muted/75"> · {chat.cwd}</span>
                </Meta>
                {chat.worktree && (
                    <Meta icon={<GitForkIcon className="size-3.5 text-muted" />}>
                        <span className="text-text/85">{chat.worktree.branch}</span>
                        <span className="text-muted/75"> · worktree</span>
                    </Meta>
                )}
                {model && (
                    <Meta icon={<ClaudeMark className="size-3.5" />}>
                        <span className="text-text/85">{model.label}</span>
                        {reasoning && <span className="text-muted/75"> · {REASONING_LABELS[reasoning]}</span>}
                        {fast && <span className="text-muted/75"> · Fast</span>}
                    </Meta>
                )}
                {working && (
                    <Meta icon={<StatusMark status="working" />}>
                        <span className="text-text/85">{STATUS.working.label}</span>
                    </Meta>
                )}
            </div>
        </div>
    );
}

function Meta({ icon, children }: { icon: ReactNode; children: ReactNode }) {
    return (
        <div className="flex min-w-0 items-center gap-2 text-xs">
            <span className="flex w-4 shrink-0 justify-center">{icon}</span>
            <span className="min-w-0 truncate">{children}</span>
        </div>
    );
}
