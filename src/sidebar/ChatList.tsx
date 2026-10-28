import { useState, type ReactNode } from "react";
import { CaretRightIcon, PlusIcon } from "@phosphor-icons/react";
import { chats, useChatsStore } from "@/chats";
import { composer, folderName, useComposerStore } from "@/composer";
import { ProjectIcon } from "@/composer/ProjectIcon";
import { cn } from "@/lib/cn";
import type { Chat } from "@/proto";
import { ChatRow } from "./ChatRow";
import { DeleteChatDialog } from "./DeleteChatDialog";
import { useSidebarGroups, type ProjectGroup } from "./groups";
import { ARCHIVED, isCollapsed, PINNED, projectKey, useSidebarStore } from "./store";

/** Chats a project lists before "Show more". */
const PROJECT_LIMIT = 6;

/** Pinned chats, then each project's, then Archived. */
export function ChatList() {
    const { pinned, projects, archived } = useSidebarGroups();
    const loaded = useChatsStore((s) => s.loaded);
    const [deleting, setDeleting] = useState<Chat | null>(null);

    const row = (chat: Chat) => (
        <ChatRow key={chat.id} chat={chat} onDelete={setDeleting} />
    );

    if (loaded && !pinned.length && !projects.length && !archived.length) {
        return (
            <p className="px-2 py-6 text-center text-xs text-dark-300">
                No chats yet. Pick a folder and send a prompt to start one.
            </p>
        );
    }

    return (
        <>
            <div className="flex flex-col gap-3">
                {pinned.length > 0 && (
                    <Section sectionKey={PINNED} label="Pinned">
                        {pinned.map(row)}
                    </Section>
                )}

                {projects.length > 0 && (
                    <div className="flex flex-col gap-1">
                        {projects.map((project) => (
                            <Project key={project.path} project={project} row={row} />
                        ))}
                    </div>
                )}

                {archived.length > 0 && (
                    <Section sectionKey={ARCHIVED} label="Archived" count={archived.length}>
                        {archived.map(row)}
                    </Section>
                )}
            </div>

            <DeleteChatDialog chat={deleting} onClose={() => setDeleting(null)} />
        </>
    );
}

function useFold(key: string) {
    const collapsed = useSidebarStore((s) => isCollapsed(s.collapsed, key));
    const toggle = useSidebarStore((s) => s.toggle);
    return [collapsed, () => toggle(key)] as const;
}

/** A muted, foldable label over a flat list of chats. */
function Section({
    sectionKey,
    label,
    count,
    children
}: {
    sectionKey: string;
    label: string;
    count?: number;
    children: ReactNode;
}) {
    const [collapsed, toggle] = useFold(sectionKey);
    return (
        <section>
            <button
                type="button"
                onClick={toggle}
                aria-expanded={!collapsed}
                className={cn(
                    "group/head flex h-6 w-full items-center gap-1 rounded-md px-2 text-[11px] font-medium text-dark-300 outline-none",
                    "transition-colors hover:text-dark-100 focus-visible:text-dark-100"
                )}
            >
                <span>{label}</span>
                {count !== undefined && <span className="text-dark-400">{count}</span>}
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

/**
 * A project: its icon and folder name (folds the list), a "+" for a new chat
 * there, and its chats. Lists the first few; the open chat always shows.
 */
function Project({
    project,
    row
}: {
    project: ProjectGroup;
    row: (chat: Chat) => ReactNode;
}) {
    const { path, chats: list } = project;
    const [collapsed, toggle] = useFold(projectKey(path));
    const [expanded, setExpanded] = useState(false);
    const activeIndex = useChatsStore((s) => list.findIndex((c) => c.id === s.activeChatId));
    // The new-chat view is open on this project.
    const pickedForNewChat = useComposerStore((s) => s.newChat.cwd === path);
    const inNewChat = useChatsStore((s) => s.activeChatId === null);
    const newChatHere = pickedForNewChat && inNewChat;

    const shown = expanded
        ? list.length
        : Math.max(PROJECT_LIMIT, activeIndex + 1);
    const hidden = list.length - shown;
    const name = folderName(path);

    const startChat = () => {
        useComposerStore.getState().setNewChat({ cwd: path });
        chats.select(null);
        composer.focus();
    };

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
                    <ProjectIcon path={path} selected={newChatHere} />
                    <span className="min-w-0 truncate">{name}</span>
                    <Caret
                        open={!collapsed}
                        className="text-dark-300 opacity-0 group-hover/head:opacity-100"
                    />
                </button>
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
            </div>

            {!collapsed && (
                <div className="flex flex-col gap-px">
                    {list.length === 0 && (
                        <p className="py-1 pl-8 text-[11px] text-dark-300">No chats</p>
                    )}
                    {list.slice(0, shown).map(row)}
                    {(hidden > 0 || expanded) && list.length > PROJECT_LIMIT && (
                        <button
                            type="button"
                            onClick={() => setExpanded((e) => !e)}
                            className="h-6 rounded-md pl-8 text-left text-[11px] text-dark-300 outline-none transition-colors hover:text-dark-100 focus-visible:text-dark-100"
                        >
                            {expanded ? "Show less" : `Show ${hidden} more`}
                        </button>
                    )}
                </div>
            )}
        </section>
    );
}
