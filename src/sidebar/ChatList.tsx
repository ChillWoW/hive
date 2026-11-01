import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ArchiveIcon, CaretRightIcon, PlusIcon } from "@phosphor-icons/react";
import { chats, useChatsStore } from "@/chats";
import { baseName } from "@/lib/paths";
import {
    composer,
    useComposerStore,
    useNewChatDrafts,
    type NewChatDraft
} from "@/composer";
import { ProjectIcon } from "@/projects/ProjectIcon";
import { useShortcut } from "@/keybindings";
import { cn } from "@/lib/cn";
import type { Chat } from "@/proto";
import { Tooltip } from "@/ui";
import { CARD_DWELL, ChatRow } from "./ChatRow";
import { DeleteChatDialog } from "./DeleteChatDialog";
import { DraftRow } from "./DraftRow";
import { useSidebarGroups, type ProjectGroup } from "./groups";
import { ROW_ACTION, warn } from "./rows";
import {
    ARCHIVED,
    DRAFTS,
    isCollapsed,
    PINNED,
    projectKey,
    useSidebarStore
} from "./store";

/** Chats a group lists before "Show more". */
const GROUP_LIMIT = 6;

type Row = (chat: Chat) => ReactNode;

/** Pinned chats, then each project's, then Archived. */
export function ChatList() {
    const { pinned, projects: listed, archived } = useSidebarGroups();
    const loaded = useChatsStore((s) => s.loaded);
    const allChats = useChatsStore((s) => s.chats);
    const [deleting, setDeleting] = useState<Chat | null>(null);
    const newDrafts = useNewChatDrafts();

    // A deleted chat's draft goes with it.
    useEffect(() => {
        if (loaded) composer.pruneDrafts(new Set(allChats.map((c) => c.id)));
    }, [loaded, allChats]);

    // New-chat drafts sit at the top of their folder's project (listed at the
    // bottom if it isn't one); drafts with no folder picked yet in Drafts.
    const { projects, draftsByPath, looseDrafts } = useMemo(() => {
        const draftsByPath = new Map<string, NewChatDraft[]>();
        const looseDrafts: NewChatDraft[] = [];
        for (const draft of newDrafts) {
            if (!draft.cwd) {
                looseDrafts.push(draft);
                continue;
            }
            const list = draftsByPath.get(draft.cwd) ?? [];
            list.push(draft);
            draftsByPath.set(draft.cwd, list);
        }
        const paths = new Set(listed.map((p) => p.path));
        const extra = [...draftsByPath.keys()]
            .filter((path) => !paths.has(path))
            .map((path) => ({ path, chats: [] }));
        return { projects: [...listed, ...extra], draftsByPath, looseDrafts };
    }, [listed, newDrafts]);

    // Sidebar order, folded groups included, Archived left out.
    const ordered = () => [...pinned, ...projects.flatMap((p) => p.chats)];

    // Archived only while in it.
    const step = (by: 1 | -1) => {
        const activeId = useChatsStore.getState().activeChatId;
        const order = ordered();
        if (archived.some((c) => c.id === activeId)) order.push(...archived);
        if (!order.length) return false;
        const index = order.findIndex((c) => c.id === activeId);
        const next =
            index < 0
                ? by > 0
                    ? 0
                    : order.length - 1
                : (index + by + order.length) % order.length;
        chats.select(order[next]!.id);
    };
    useShortcut("nextChat", () => step(1));
    useShortcut("previousChat", () => step(-1));

    // Archives the open chat and opens the one below it (else above, else the
    // new-chat view), so a run of chats can be cleared key by key. An archived
    // one is unarchived in place.
    useShortcut("archiveChat", () => {
        const activeId = useChatsStore.getState().activeChatId;
        const chat = activeId && allChats.find((c) => c.id === activeId);
        if (!chat) return false;
        if (chat.archived) {
            chats.setArchived(chat.id, false).catch(warn);
            return;
        }
        const order = ordered();
        const index = order.findIndex((c) => c.id === chat.id);
        const next = index < 0 ? undefined : (order[index + 1] ?? order[index - 1]);
        chats.select(next?.id ?? null);
        chats.setArchived(chat.id, true).catch(warn);
    });

    const row: Row = (chat) => <ChatRow key={chat.id} chat={chat} onDelete={setDeleting} />;

    const query = useSidebarStore((s) => s.query);
    const found = useMemo(
        () => filterGroups(query, { pinned, projects, archived }),
        [query, pinned, projects, archived]
    );
    // Search results show unfolded, every chat listed, drafts left out.
    const searching = found !== null;
    const shown = found ?? { pinned, projects, archived };
    const empty = !shown.pinned.length && !shown.projects.length && !shown.archived.length;

    if (!searching && loaded && empty && !newDrafts.length) {
        return (
            <p className="px-2 py-6 text-center text-xs text-dark-250">
                No chats yet. Pick a folder and send a prompt to start one.
            </p>
        );
    }

    return (
        // Once a row's card has shown, the next row's follows at once until
        // the pointer rests off the list for a moment.
        <Tooltip.Provider delay={CARD_DWELL} timeout={400}>
            {searching && empty ? (
                <p className="px-2 py-6 text-center text-xs text-dark-250">
                    No chats match “{query.trim()}”.
                </p>
            ) : (
                <div className="flex flex-col gap-3">
                    {!searching && looseDrafts.length > 0 && (
                        <Section sectionKey={DRAFTS} label="Drafts">
                            {looseDrafts.map((draft) => (
                                <DraftRow key={draft.key} draft={draft} />
                            ))}
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
                                <Project
                                    key={project.path}
                                    project={project}
                                    drafts={searching ? undefined : draftsByPath.get(project.path)}
                                    row={row}
                                    forceOpen={searching}
                                />
                            ))}
                            {shown.archived.length > 0 && (
                                <Group
                                    foldKey={ARCHIVED}
                                    icon={<ArchiveIcon className="size-4 shrink-0 text-dark-250" />}
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

type Groups = { pinned: Chat[]; projects: ProjectGroup[]; archived: Chat[] };

/**
 * What a search shows (null while the query is blank): chats whose title,
 * folder name or branch has every word of it; a project whose name has them
 * keeps all its chats. Groups left empty drop out.
 */
function filterGroups(query: string, groups: Groups): Groups | null {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return null;
    const matches = (text: string) => {
        const lower = text.toLowerCase();
        return words.every((word) => lower.includes(word));
    };
    const chatMatches = (chat: Chat) =>
        matches(
            [chat.title ?? "", baseName(chat.cwd), chat.worktree?.branch ?? ""].join(" ")
        );
    return {
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
    forceOpen,
    children
}: {
    sectionKey: string;
    label: string;
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
                    "group/head flex h-6 w-full items-center gap-1 rounded-md px-2 text-[11px] font-medium text-dark-250 outline-none",
                    "transition-colors hover:text-dark-100 focus-visible:text-dark-100"
                )}
            >
                <span>{label}</span>
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
            className={cn(
                "size-2.5 shrink-0 transition-[transform,opacity] duration-150",
                open && "rotate-90",
                className
            )}
        />
    );
}

/** A project's group, with a "+" for a new chat in its folder. */
function Project({
    project,
    drafts,
    row,
    forceOpen
}: {
    project: ProjectGroup;
    /** New-chat drafts in this folder. */
    drafts?: NewChatDraft[];
    row: Row;
    forceOpen?: boolean;
}) {
    const { path } = project;
    // The new-chat view is open on this project.
    const pickedForNewChat = useComposerStore((s) => s.newChat.cwd === path);
    const inNewChat = useChatsStore((s) => s.activeChatId === null);
    const name = baseName(path);

    const startChat = () => {
        composer.startNewChat(path);
        chats.select(null);
        composer.focus();
    };

    return (
        <Group
            foldKey={projectKey(path)}
            icon={<ProjectIcon path={path} selected={pickedForNewChat && inNewChat} />}
            name={name}
            list={project.chats}
            drafts={drafts}
            row={row}
            forceOpen={forceOpen}
            action={
                <button
                    type="button"
                    onClick={startChat}
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
    drafts = [],
    row,
    counted,
    action,
    forceOpen = false
}: {
    foldKey: string;
    icon: ReactNode;
    name: string;
    list: Chat[];
    /** Listed above the chats, all of them. */
    drafts?: NewChatDraft[];
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

    const shown =
        expanded || forceOpen ? list.length : Math.max(GROUP_LIMIT, activeIndex + 1);
    const hidden = list.length - shown;

    return (
        <section>
            <div className="group/head relative">
                <button
                    type="button"
                    onClick={toggle}
                    aria-expanded={!collapsed}
                    className={cn(
                        "flex h-7 w-full items-center gap-2 rounded-md pr-12 pl-2 text-left text-xs font-medium outline-none",
                        "text-dark-200 transition-colors hover:bg-dark-800 hover:text-dark-50",
                        "focus-visible:ring-1 focus-visible:ring-dark-400"
                    )}
                >
                    {icon}
                    <span className="min-w-0 truncate">{name}</span>
                    {counted && <span className="shrink-0 text-dark-250">{list.length}</span>}
                    <Caret
                        open={!collapsed}
                        className="text-dark-250 opacity-0 group-hover/head:opacity-100"
                    />
                </button>
                {action}
            </div>

            {!collapsed && (
                <div className="flex flex-col gap-px">
                    {drafts.map((draft) => (
                        <DraftRow key={draft.key} draft={draft} />
                    ))}
                    {list.length === 0 && drafts.length === 0 && (
                        <p className="py-1 pl-8 text-[11px] text-dark-250">No chats</p>
                    )}
                    {list.slice(0, shown).map(row)}
                    {(hidden > 0 || expanded) && list.length > GROUP_LIMIT && (
                        <button
                            type="button"
                            onClick={() => setExpanded((e) => !e)}
                            className="h-6 rounded-md pl-8 text-left text-[11px] text-dark-250 outline-none transition-colors hover:text-dark-100 focus-visible:text-dark-100"
                        >
                            {expanded ? "Show less" : `Show ${hidden} more`}
                        </button>
                    )}
                </div>
            )}
        </section>
    );
}
