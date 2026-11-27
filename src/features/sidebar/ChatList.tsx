import { useMemo, useState, type ReactNode } from "react";
import { ArchiveIcon, CaretRightIcon, PlusIcon } from "@phosphor-icons/react";
import { chats, useChatsStore } from "@/features/chats";
import { ProjectIcon } from "@/features/projects";
import { cn } from "@/lib/cn";
import { baseName } from "@/lib/paths";
import type { Chat } from "@/proto";
import { Tooltip } from "@/ui";
import { CARD_DWELL, ChatRow } from "./ChatRow";
import { DeleteChatDialog } from "./DeleteChatDialog";
import { isNested, useSidebarGroups, type ProjectGroup } from "./groups";
import { ROW_ACTION } from "./rows";
import { ACTIVE, ARCHIVED, isCollapsed, PINNED, projectKey, useSidebarStore } from "./store";

/** Chats a group lists before "Show more". */
const GROUP_LIMIT = 6;

type Row = (chat: Chat, index: number, list: Chat[]) => ReactNode;

/** Running chats, pinned ones, then each project's, then Archived; a search filters them. */
export function ChatList() {
    const groups = useSidebarGroups();
    const loaded = useChatsStore((s) => s.loaded);
    const [deleting, setDeleting] = useState<Chat | null>(null);

    const row: Row = (chat, _, list) => (
        <ChatRow key={chat.id} chat={chat} onDelete={setDeleting} nested={isNested(chat, list)} />
    );
    // Active mixes projects, so its rows say whose they are.
    const activeRow: Row = (chat, _, list) => (
        <ChatRow key={chat.id} chat={chat} onDelete={setDeleting} showProject nested={isNested(chat, list)} />
    );

    const query = useSidebarStore((s) => s.query);
    const found = useMemo(() => filterGroups(query, groups), [query, groups]);
    // Search results show unfolded, every chat listed.
    const searching = found !== null;
    const shown = found ?? groups;
    const empty =
        !shown.active.length && !shown.pinned.length && !shown.projects.length && !shown.archived.length;

    if (!searching && loaded && empty) {
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
            {searching && empty ? (
                <p className="px-2 py-6 text-center text-xs text-muted/75">
                    No chats match “{query.trim()}”.
                </p>
            ) : (
                <div className="flex flex-col gap-3">
                    {shown.active.length > 0 && (
                        <Section
                            sectionKey={ACTIVE}
                            label="Active"
                            count={shown.active.length}
                            forceOpen={searching}
                        >
                            {shown.active.map(activeRow)}
                        </Section>
                    )}

                    {shown.pinned.length > 0 && (
                        <Section sectionKey={PINNED} label="Pinned" forceOpen={searching}>
                            {shown.pinned.map(row)}
                        </Section>
                    )}

                    {(shown.projects.length > 0 || shown.archived.length > 0) && (
                        <div className="flex flex-col gap-1">
                            {shown.projects.map((project) => (
                                <Project key={project.path} project={project} row={row} forceOpen={searching} />
                            ))}
                            {shown.archived.length > 0 && (
                                <Group
                                    foldKey={ARCHIVED}
                                    icon={<ArchiveIcon className="size-4 shrink-0 text-muted/75" />}
                                    name="Archived"
                                    list={shown.archived}
                                    counted
                                    row={row}
                                    forceOpen={searching}
                                />
                            )}
                        </div>
                    )}
                </div>
            )}

            <DeleteChatDialog chat={deleting} onClose={() => setDeleting(null)} />
        </Tooltip.Provider>
    );
}

type Groups = { active: Chat[]; pinned: Chat[]; projects: ProjectGroup[]; archived: Chat[] };

/**
 * What a search shows (null while the query is blank): chats whose title or
 * folder name has every word of it; a project whose name has them keeps all
 * its chats. Groups left empty drop out.
 */
function filterGroups(query: string, groups: Groups): Groups | null {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return null;
    const matches = (text: string) => {
        const lower = text.toLowerCase();
        return words.every((word) => lower.includes(word));
    };
    const chatMatches = (chat: Chat) =>
        matches(`${chat.title ?? ""} ${baseName(chat.cwd)} ${chat.worktree?.branch ?? ""}`);
    return {
        active: groups.active.filter(chatMatches),
        pinned: groups.pinned.filter(chatMatches),
        projects: groups.projects.flatMap((project) => {
            if (matches(baseName(project.path))) return [project];
            const list = project.chats.filter(chatMatches);
            return list.length ? [{ ...project, chats: list }] : [];
        }),
        archived: groups.archived.filter(chatMatches)
    };
}

/** `forceOpen` (search results) shows it unfolded without touching the saved fold. */
function useFold(key: string, forceOpen = false) {
    const collapsed = useSidebarStore((s) => isCollapsed(s.collapsed, key));
    const toggle = useSidebarStore((s) => s.toggle);
    return [collapsed && !forceOpen, () => toggle(key)] as const;
}

/** A muted, foldable label over a flat list of chats. */
function Section({
    sectionKey,
    label,
    count,
    forceOpen,
    children
}: {
    sectionKey: string;
    label: string;
    /** Shown after the label, muted. */
    count?: number;
    forceOpen?: boolean;
    children: ReactNode;
}) {
    const [collapsed, toggle] = useFold(sectionKey, forceOpen);
    return (
        <section>
            <button
                type="button"
                onClick={toggle}
                aria-expanded={!collapsed}
                className={cn(
                    "group/head flex h-6 w-full items-center gap-1 rounded-md px-2 text-[11px] font-medium text-muted/75 outline-none",
                    "transition-colors hover:text-text/85 focus-visible:text-text/85"
                )}
            >
                <span>{label}</span>
                {count !== undefined && <span className="tabular-nums">{count}</span>}
                <Caret open={!collapsed} className="ml-auto opacity-0 group-hover/head:opacity-100" />
            </button>
            {!collapsed && <div className="flex flex-col gap-px">{children}</div>}
        </section>
    );
}

function Caret({ open, className }: { open: boolean; className?: string }) {
    return (
        <CaretRightIcon
            weight="bold"
            className={cn("size-2.5 shrink-0 transition-[transform,opacity] duration-150", open && "rotate-90", className)}
        />
    );
}

/** A project's group, with a "+" for a new chat in its folder. */
function Project({ project, row, forceOpen }: { project: ProjectGroup; row: Row; forceOpen?: boolean }) {
    const { path } = project;
    // The new-chat view is open on this project.
    const picked = useChatsStore((s) => s.activeChatId === null && s.newChatCwd === path);
    const name = baseName(path);

    return (
        <Group
            foldKey={projectKey(path)}
            icon={<ProjectIcon path={path} selected={picked} />}
            name={name}
            list={project.chats}
            emptyLabel={project.active ? "All chats active" : "No chats"}
            row={row}
            forceOpen={forceOpen}
            action={
                <button
                    type="button"
                    onClick={() => chats.startNew(path)}
                    aria-label={`New chat in ${name}`}
                    className={cn(ROW_ACTION, "right-1.5 group-hover/head:opacity-100")}
                >
                    <PlusIcon className="size-3.5" />
                </button>
            }
        />
    );
}

/**
 * A foldable group of chats under an icon and a name (a project, or
 * Archived), with an optional hover `action` on the right. Lists the first
 * few; the open chat always shows.
 */
function Group({
    foldKey,
    icon,
    name,
    list,
    emptyLabel = "No chats",
    row,
    counted,
    action,
    forceOpen = false
}: {
    foldKey: string;
    icon: ReactNode;
    name: string;
    list: Chat[];
    emptyLabel?: string;
    row: Row;
    /** Shows how many chats it has after the name, muted. */
    counted?: boolean;
    action?: ReactNode;
    /** Search results: unfolded, every chat listed. */
    forceOpen?: boolean;
}) {
    const [collapsed, toggle] = useFold(foldKey, forceOpen);
    const [expanded, setExpanded] = useState(false);
    const activeIndex = useChatsStore((s) => list.findIndex((c) => c.id === s.activeChatId));

    const shown = expanded || forceOpen ? list.length : Math.max(GROUP_LIMIT, activeIndex + 1);
    const hidden = list.length - shown;

    return (
        <section>
            <div className="group/head relative">
                <button
                    type="button"
                    onClick={toggle}
                    aria-expanded={!collapsed}
                    className={cn(
                        "flex h-7 w-full items-center gap-2 rounded-md pr-8 pl-2 text-left text-xs font-medium outline-none",
                        "text-muted transition-colors hover:bg-raised hover:text-text",
                        "focus-visible:ring-1 focus-visible:ring-muted/50"
                    )}
                >
                    {icon}
                    <span className="min-w-0 truncate">{name}</span>
                    {counted && <span className="shrink-0 text-muted/75">{list.length}</span>}
                    <Caret open={!collapsed} className="text-muted/75 opacity-0 group-hover/head:opacity-100" />
                </button>
                {action}
            </div>

            {!collapsed && (
                <div className="flex flex-col gap-px">
                    {list.length === 0 && <p className="py-1 pl-8 text-[11px] text-muted/75">{emptyLabel}</p>}
                    {list.slice(0, shown).map(row)}
                    {(hidden > 0 || expanded) && list.length > GROUP_LIMIT && (
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
