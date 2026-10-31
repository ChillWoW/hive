import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ArchiveIcon, CaretRightIcon, PlusIcon } from "@phosphor-icons/react";
import { chats, useChatsStore } from "@/chats";
import {
    composer,
    folderName,
    useComposerStore,
    useNewChatDrafts,
    type NewChatDraft
} from "@/composer";
import { ProjectIcon } from "@/composer/ProjectIcon";
import { useShortcut } from "@/keybindings";
import { cn } from "@/lib/cn";
import type { Chat } from "@/proto";
import { Tooltip } from "@/ui";
import { CARD_DWELL, ChatRow } from "./ChatRow";
import { DeleteChatDialog } from "./DeleteChatDialog";
import { DraftRow } from "./DraftRow";
import { useSidebarGroups, type ProjectGroup } from "./groups";
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

    // Sidebar order, folded groups included; Archived only while in it.
    const step = (by: 1 | -1) => {
        const activeId = useChatsStore.getState().activeChatId;
        const order = [...pinned, ...projects.flatMap((p) => p.chats)];
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
        const warn = (error: unknown) => console.warn("[sidebar]", error);
        if (chat.archived) {
            chats.setArchived(chat.id, false).catch(warn);
            return;
        }
        const order = [...pinned, ...projects.flatMap((p) => p.chats)];
        const index = order.findIndex((c) => c.id === chat.id);
        const next = index < 0 ? undefined : (order[index + 1] ?? order[index - 1]);
        chats.select(next?.id ?? null);
        chats.setArchived(chat.id, true).catch(warn);
    });

    const row: Row = (chat) => (
        <ChatRow key={chat.id} chat={chat} onDelete={setDeleting} />
    );

    const query = useSidebarStore((s) => s.query);
    const shown = useMemo(
        () => filterGroups(query, { pinned, projects, archived }),
        [query, pinned, projects, archived]
    );

    if (shown) {
        const empty =
            !shown.pinned.length && !shown.projects.length && !shown.archived.length;
        return (
            <Tooltip.Provider delay={CARD_DWELL} timeout={400}>
                {empty ? (
                    <p className="px-2 py-6 text-center text-xs text-dark-250">
                        No chats match “{query.trim()}”.
                    </p>
                ) : (
                    <div className="flex flex-col gap-3">
                        {shown.pinned.length > 0 && (
                            <Section sectionKey={PINNED} label="Pinned" forceOpen>
                                {shown.pinned.map(row)}
                            </Section>
                        )}
                        <div className="flex flex-col gap-1">
                            {shown.projects.map((project) => (
                                <Project
                                    key={project.path}
                                    project={project}
                                    row={row}
                                    forceOpen
                                />
                            ))}
                            {shown.archived.length > 0 && (
                                <Group
                                    foldKey={ARCHIVED}
                                    icon={
                                        <ArchiveIcon className="size-4 shrink-0 text-dark-250" />
                                    }
                                    name="Archived"
                                    list={shown.archived}
                                    count={shown.archived.length}
                                    row={row}
                                    forceOpen
                                />
                            )}
                        </div>
                    </div>
                )}
                <DeleteChatDialog chat={deleting} onClose={() => setDeleting(null)} />
            </Tooltip.Provider>
        );
    }

    if (
        loaded &&
        !pinned.length &&
        !projects.length &&
        !archived.length &&
        !newDrafts.length
    ) {
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
            <div className="flex flex-col gap-3">
                {looseDrafts.length > 0 && (
                    <Section sectionKey={DRAFTS} label="Drafts">
                        {looseDrafts.map((draft) => (
                            <DraftRow key={draft.key} draft={draft} />
                        ))}
                    </Section>
                )}

                {pinned.length > 0 && (
                    <Section sectionKey={PINNED} label="Pinned">
                        {pinned.map(row)}
                    </Section>
                )}

                {(projects.length > 0 || archived.length > 0) && (
                    <div className="flex flex-col gap-1">
                        {projects.map((project) => (
                            <Project
                                key={project.path}
                                project={project}
                                drafts={draftsByPath.get(project.path)}
                                row={row}
                            />
                        ))}
                        {archived.length > 0 && (
                            <Group
                                foldKey={ARCHIVED}
                                icon={<ArchiveIcon className="size-4 shrink-0 text-dark-250" />}
                                name="Archived"
                                list={archived}
                                count={archived.length}
                                row={row}
                            />
                        )}
                    </div>
                )}
            </div>

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
            [chat.title ?? "", folderName(chat.cwd), chat.worktree?.branch ?? ""].join(" ")
        );
    return {
        pinned: groups.pinned.filter(chatMatches),
        projects: groups.projects.flatMap((project) => {
            if (matches(folderName(project.path))) return [project];
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
    const name = folderName(path);

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
                    className={cn(
                        "absolute top-1/2 right-1.5 inline-flex size-5 -translate-y-1/2 items-center justify-center rounded-sm outline-none",
                        "text-dark-200 transition-[color,background-color,opacity] duration-100",
                        "hover:bg-dark-600 hover:text-dark-50",
                        "opacity-0 group-hover/head:opacity-100 focus-visible:opacity-100"
                    )}
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
    count,
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
    /** Shown after the name, muted. */
    count?: number;
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
                    {count !== undefined && (
                        <span className="shrink-0 text-dark-250">{count}</span>
                    )}
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
