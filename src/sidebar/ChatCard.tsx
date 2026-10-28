import type { ReactNode } from "react";
import { GitBranchIcon } from "@phosphor-icons/react";
import { activity } from "@/chats";
import { folderName } from "@/composer";
import { ProjectIcon } from "@/composer/ProjectIcon";
import { useGitRepo } from "@/git";
import {
    HarnessIcon,
    REASONING_LABELS,
    resolveModel,
    resolveReasoning,
    useCatalog
} from "@/harnesses";
import type { Chat, Session } from "@/proto";
import { STATUS, statusOf } from "./status";
import { StatusMark } from "./StatusMark";
import { timeAgo, useMinuteClock } from "./time";

/** "21h ago"; "just now" under a minute. */
function agoLabel(at: number, now: number) {
    const ago = timeAgo(at, now);
    return ago === "now" ? "just now" : `${ago} ago`;
}

/**
 * What a sidebar row has no room for, shown in its hover card (as in
 * zeron): the whole title and its age, then where it runs, on what, and
 * what it's doing.
 */
export function ChatCard({
    chat,
    session,
    title
}: {
    chat: Chat;
    session: Session | undefined;
    title: string;
}) {
    const now = useMinuteClock();
    const catalog = useCatalog(chat.config.harness);
    const model = resolveModel(catalog, chat.config);
    const reasoning = resolveReasoning(model, chat.config);
    const status = statusOf(chat, session);
    const repo = useGitRepo(chat.cwd)?.repo;
    const branch = repo ? (repo.branch ?? repo.commit) : undefined;
    const context = chat.context;
    const used =
        context?.tokens != null && context.window
            ? Math.round((context.tokens / context.window) * 100)
            : null;

    return (
        <div className="flex flex-col gap-2.5">
            <div className="flex flex-col gap-0.5">
                <p className="text-[13px] leading-snug font-medium break-words text-dark-50">
                    {title}
                </p>
                <p className="text-[11px] text-dark-250">{agoLabel(activity(chat), now)}</p>
            </div>

            <div className="flex flex-col gap-1.5 border-t border-dark-600 pt-2.5">
                <Meta icon={<ProjectIcon path={chat.cwd} className="size-3.5" />}>
                    <span className="text-dark-100">{folderName(chat.cwd)}</span>
                </Meta>
                {branch && (
                    <Meta icon={<GitBranchIcon className="size-3.5 text-dark-200" />}>
                        <span className="text-dark-100">{branch}</span>
                        {!repo?.branch && <span className="text-dark-250"> · detached</span>}
                    </Meta>
                )}
                <Meta icon={<HarnessIcon harness={chat.config.harness} className="size-3.5" />}>
                    <span className="text-dark-100">
                        {model?.label ?? chat.config.model ?? catalog?.label ?? "Default model"}
                    </span>
                    {reasoning && (
                        <span className="text-dark-250"> · {REASONING_LABELS[reasoning]}</span>
                    )}
                </Meta>
                {status !== "idle" && (
                    <Meta icon={<StatusMark status={status} />}>
                        <span className="text-dark-100">{STATUS[status].label}</span>
                        {used !== null && (
                            <span className="text-dark-250"> · {used}% context used</span>
                        )}
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
