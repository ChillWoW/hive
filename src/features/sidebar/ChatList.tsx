import { useMemo, useState, type ReactNode } from "react";
import { ArchiveIcon, CaretRightIcon, NotePencilIcon, PlusIcon } from "@phosphor-icons/react";
import { chats, useChatsStore } from "@/features/chats";
import { ProjectIcon } from "@/features/projects";
import { cn } from "@/lib/cn";
import { baseName } from "@/lib/paths";
import type { Chat } from "@/proto";
import { Tooltip } from "@/ui";
import { CARD_DWELL, ChatRow } from "./ChatRow";
import { DeleteChatDialog } from "./DeleteChatDialog";
import {
    activeFilter,
    countStatuses,
    isNested,
    present,
    useSidebarGroups,
    useStatuses,
    type SidebarGroups,
    type Statuses
} from "./groups";
import { ROW_ACTION, rowClassName } from "./rows";
import { STATUS, type LiveStatus } from "./status";
import { StatusMark } from "./StatusMark";
import { ARCHIVED, isCollapsed, projectKey, useSidebarStore } from "./store";

/** Chats a group lists before "Show more". */
const GROUP_LIMIT = 6;

type Row = (chat: Chat, index: number, list: Chat[]) => ReactNode;

/**
 * Every project's chats, then Archived. A chat stays in its project whatever
 * it's doing; its row says what that is. A search or a status filter
 * (`StatusFilter`) narrows the list.
 */
export function ChatList() {
    const groups = useSidebarGroups();
    const statuses = useStatuses();
    const loaded = useChatsStore((s) => s.loaded);
    const [deleting, setDeleting] = useState<Chat | null>(null);

    const row: Row = (chat, _, list) => (
        <ChatRow
            key={chat.id}
            chat={chat}
            status={statuses.of.get(chat.id) ?? "idle"}
            onDelete={setDeleting}
            nested={isNested(chat, list)}
        />
    );

    const query = useSidebarStore((s) => s.query);
    const filter = useSidebarStore((s) => activeFilter(s.filter, statuses.counts));
    const found = useMemo(
        () => narrow(groups, query, filter, statuses.of),
        [groups, query, filter, statuses.of]
    );
    // Narrowed, the list shows unfolded, every match listed.
    const narrowed = found !== null;
    const shown = found ?? groups;
    const empty = !shown.projects.length && !shown.archived.length;

    if (!narrowed && loaded && empty) {
        return (
            <p className="px-2 py-6 text-center text-xs text-muted/75">
                No chats yet. Pick a folder and send a prompt to start one.
            </p>
        );
    }

    return (
        // Once a row's card has shown, the next row's follows at once until
        // the pointer rests off the list for a moment.
        <Tooltip.Provider delay={CARD_DWELL} timeout={400}>
            {narrowed && empty ? (
                <p className="px-2 py-6 text-center text-xs text-muted/75">
                    {query.trim() ? `No chats match “${query.trim()}”.` : "No chats."}
                </p>
            ) : (
                <div className="flex flex-col gap-2.5">
                    {shown.projects.map((project) => (
                        <Group
                            key={project.path}
                            foldKey={projectKey(project.path)}
                            icon={<Icon path={project.path} />}
                            name={baseName(project.path)}
                            list={project.chats}
                            statuses={statuses.of}
                            row={row}
                            forceOpen={narrowed}
                            action={<NewChat path={project.path} />}
                            draftPath={project.path}
                        />
                    ))}
                    {shown.archived.length > 0 && (
                        <Group
                            foldKey={ARCHIVED}
                            icon={<ArchiveIcon className="size-4 shrink-0 text-muted/75" />}
                            name="Archived"
                            list={shown.archived}
                            statuses={statuses.of}
                            row={row}
                            forceOpen={narrowed}
                            quiet
                        />
                    )}
                </div>
            )}

            <DeleteChatDialog chat={deleting} onClose={() => setDeleting(null)} />
        </Tooltip.Provider>
    );
}

/**
 * What a search or a status filter leaves (null while neither is on): chats
 * with the filter's status whose title, folder or branch has every word of
 * the query; a project whose name has them keeps all its chats. Groups left
 * empty drop out; a status filter leaves Archived out.
 */
function narrow(
    groups: SidebarGroups,
    query: string,
    filter: LiveStatus | null,
    statuses: Statuses["of"]
): SidebarGroups | null {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length && !filter) return null;
    const matches = (text: string) => {
        const lower = text.toLowerCase();
        return words.every((word) => lower.includes(word));
    };
    const hasStatus = (chat: Chat) => !filter || statuses.get(chat.id) === filter;
    const chatMatches = (chat: Chat) =>
        matches(`${chat.title ?? ""} ${baseName(chat.cwd)} ${chat.worktree?.branch ?? ""}`);
    return {
        projects: groups.projects.flatMap((project) => {
            const named = words.length > 0 && matches(baseName(project.path));
            const list = project.chats.filter((chat) => hasStatus(chat) && (named || chatMatches(chat)));
            // A project found by name shows even with no chats; not under a filter.
            return list.length || (named && !filter) ? [{ ...project, chats: list }] : [];
        }),
        archived: filter ? [] : groups.archived.filter(chatMatches)
    };
}

/** A project's icon, tinted while the new-chat view is open on it. */
function Icon({ path }: { path: string }) {
    const picked = useChatsStore((s) => s.activeChatId === null && s.newChatCwd === path);
    return <ProjectIcon path={path} selected={picked} />;
}

/** A project header's "+": a new chat in its folder. */
function NewChat({ path }: { path: string }) {
    return (
        <button
            type="button"
            onClick={() => chats.startNew(path)}
            aria-label={`New chat in ${baseName(path)}`}
            className={cn(ROW_ACTION, "right-1.5 group-hover/head:opacity-100")}
        >
            <PlusIcon className="size-3.5" />
        </button>
    );
}

/** The chat being started in a project, where it will land: the open row until it's sent. */
function Draft() {
    return (
        <div aria-current="page" className={rowClassName(true)}>
            <span className="flex w-4 shrink-0 justify-center">
                <NotePencilIcon className="size-3 shrink-0 text-muted" />
            </span>
            <span className="min-w-0 truncate text-muted">New chat</span>
        </div>
    );
}

/**
 * A foldable group of chats under an icon and a name (a project, or
 * Archived), with an optional hover `action` on the right. Lists the first
 * few; the open chat and chats that aren't idle always show. Folded, its
 * header says what's inside: what its chats are doing, else how many it has.
 */
function Group({
    foldKey,
    icon,
    name,
    list,
    statuses,
    row,
    quiet = false,
    action,
    draftPath,
    forceOpen = false
}: {
    foldKey: string;
    icon: ReactNode;
    name: string;
    list: Chat[];
    statuses: Statuses["of"];
    row: Row;
    /** A muted name, for a group that isn't a project. */
    quiet?: boolean;
    action?: ReactNode;
    /** The project's folder: its list leads with the chat being started there. */
    draftPath?: string;
    /** A narrowed list: unfolded, every chat listed. */
    forceOpen?: boolean;
}) {
    const saved = useSidebarStore((s) => isCollapsed(s.collapsed, foldKey));
    const toggle = useSidebarStore((s) => s.toggle);
    const collapsed = saved && !forceOpen;
    const [expanded, setExpanded] = useState(false);
    const openId = useChatsStore((s) => s.activeChatId);
    const draft = useChatsStore(
        (s) => !forceOpen && draftPath !== undefined && s.activeChatId === null && s.newChatCwd === draftPath
    );

    const all = expanded || forceOpen;
    const visible = all
        ? list
        : list.filter((chat, index) => index < GROUP_LIMIT || chat.id === openId || statuses.has(chat.id));
    const hidden = list.length - visible.length;
    // Folded, the name shimmers for the working chats it hides.
    const working = collapsed && list.some((chat) => statuses.get(chat.id) === "working");

    return (
        <section>
            <div className="group/head relative">
                <button
                    type="button"
                    onClick={() => toggle(foldKey)}
                    aria-expanded={!collapsed}
                    className={cn(
                        "flex h-7 w-full items-center gap-2 rounded-md pr-1.5 pl-2 text-left text-xs font-medium outline-none",
                        "transition-colors hover:bg-raised hover:text-text",
                        "focus-visible:ring-1 focus-visible:ring-muted/50",
                        quiet ? "text-muted" : "text-text"
                    )}
                >
                    {icon}
                    <span className={cn("min-w-0 truncate", working && "shimmer text-muted")}>{name}</span>
                    <CaretRightIcon
                        weight="bold"
                        className={cn(
                            "size-2.5 shrink-0 text-muted/60 transition-transform duration-150",
                            !collapsed && "rotate-90"
                        )}
                    />
                    {collapsed && (
                        <Summary
                            list={list}
                            statuses={statuses}
                            // The action shows over it.
                            className={cn(action && "group-hover/head:invisible")}
                        />
                    )}
                </button>
                {action}
            </div>

            {!collapsed && (
                <div className="flex flex-col gap-px">
                    {draft && <Draft />}
                    {list.length === 0 && !draft && <p className="py-1 pl-8 text-[11px] text-muted/75">No chats</p>}
                    {visible.map(row)}
                    {(hidden > 0 || (expanded && list.length > GROUP_LIMIT)) && !forceOpen && (
                        <button
                            type="button"
                            onClick={() => setExpanded((e) => !e)}
                            className="h-6 rounded-md pl-8 text-left text-[11px] text-muted/75 outline-none transition-colors hover:text-text/85 focus-visible:text-text/85"
                        >
                            {expanded ? "Show less" : `Show ${hidden} more`}
                        </button>
                    )}
                </div>
            )}
        </section>
    );
}

/** A folded group's right end: its chats' statuses, most urgent first, else how many chats it has. */
function Summary({
    list,
    statuses,
    className
}: {
    list: Chat[];
    statuses: Statuses["of"];
    className?: string;
}) {
    const counts = countStatuses(list, statuses);
    const live = present(counts);
    return (
        <span
            className={cn(
                "ml-auto flex shrink-0 items-center gap-1.5 pl-1 text-[11px] font-normal text-muted/75 tabular-nums",
                className
            )}
        >
            {live.length === 0 && list.length > 0 && list.length}
            {live.map((status) => (
                <span key={status} className="flex items-center" title={`${counts[status]} ${STATUS[status].label.toLowerCase()}`}>
                    <StatusMark status={status} />
                    {counts[status] > 1 && <span className="text-text/85">{counts[status]}</span>}
                </span>
            ))}
        </span>
    );
}
