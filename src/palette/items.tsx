import { useDeferredValue, useMemo, type ReactNode } from "react";
import {
    ArchiveIcon,
    ArrowDownIcon,
    ArrowLeftIcon,
    ArrowRightIcon,
    ArrowUpIcon,
    ChartBarIcon,
    ClipboardTextIcon,
    ClockCounterClockwiseIcon,
    CursorTextIcon,
    FolderOpenIcon,
    GearIcon,
    GitDiffIcon,
    MagnifyingGlassIcon,
    PlusIcon,
    PushPinIcon,
    PushPinSlashIcon,
    SidebarSimpleIcon,
    StopIcon,
    TerminalWindowIcon,
    TrayArrowUpIcon,
    XIcon
} from "@phosphor-icons/react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { chats, useChatsStore, workDir } from "@/chats";
import { folderName } from "@/composer";
import { useWorkspaceFiles } from "@/files";
import { scoreEntry } from "@/files/rank";
import { HarnessIcon } from "@/harnesses";
import { ACTIONS, canRunAction, runAction, type ActionId } from "@/keybindings";
import { fuzzyScore, rankBy } from "@/lib/fuzzy";
import type { Chat, Session } from "@/proto";
import { openFileTab, useActiveFolder } from "@/rightbar";
import { settings } from "@/settings";
import { SETTINGS_PAGES } from "@/settings/pages";
import { statusOf, type ChatStatus } from "@/sidebar/status";
import { FileIcon, FolderTreeIcon } from "@/ui";
import { usePaletteStore } from "./store";

export type SectionId = "chats" | "files" | "actions" | "settings";

export type PaletteItem = {
    id: string;
    label: string;
    /** Muted text after the label. */
    detail?: string;
    icon: ReactNode;
    /** An action id or fixed combo, shown on the right. */
    shortcut?: string;
    /** Shown on the right for chats: the status mark, else the time. */
    chat?: { status: ChatStatus; at: number; archived: boolean };
    run: () => void;
};

export type PaletteSection = { id: SectionId; title: string; items: PaletteItem[] };

/** What a leading character narrows the search to. */
export const PREFIXES = [
    { char: ">", section: "actions", label: "actions" },
    { char: "#", section: "chats", label: "chats" },
    { char: "@", section: "files", label: "files" }
] as const;

type Scope = "all" | "actions" | "chats" | "files";

export function parseQuery(raw: string): { scope: Scope; query: string } {
    const prefix = PREFIXES.find((p) => raw.startsWith(p.char));
    return prefix
        ? { scope: prefix.section, query: raw.slice(1).trim() }
        : { scope: "all", query: raw.trim() };
}

/** Rows per section in the mixed list; a prefixed search shows more of its one. */
const MIXED = { chats: 6, files: 8, actions: 6, settings: 3 };
const SCOPED = 50;
const RECENT_CHATS = 5;
const RECENT_FILES = 5;

/**
 * A field to match: `fuzzy` ones take a tight enough subsequence (mostly
 * runs and word starts, so "comp" finds "Composer" but not "Focus prompt"),
 * the rest only a substring.
 */
type Field = { text: string; bonus: number; fuzzy?: boolean };

/** Average points per query character a fuzzy match needs (5 is one unbroken run). */
const TIGHT = 3.5;

function scoreField(word: string, { text, fuzzy }: Field): number | null {
    if (fuzzy) {
        const s = fuzzyScore(word, text);
        return s !== null && s >= word.length * TIGHT ? s : null;
    }
    return text.toLowerCase().includes(word.toLowerCase()) ? word.length * TIGHT : null;
}

/**
 * Each word of `query` in one of `fields`; the score is the words' best
 * matches (plus their field's bonus) added up, null when a word matches none.
 */
function scoreWords(query: string, fields: readonly Field[]): number | null {
    let total = 0;
    for (const word of query.split(/\s+/).filter(Boolean)) {
        let best: number | null = null;
        for (const field of fields) {
            const s = scoreField(word, field);
            if (s !== null && (best === null || s + field.bonus > best)) best = s + field.bonus;
        }
        if (best === null) return null;
        total += best;
    }
    return total;
}

const ACTION_ICONS: Partial<Record<ActionId, ReactNode>> = {
    newChat: <PlusIcon />,
    focusComposer: <CursorTextIcon />,
    previousChat: <ArrowUpIcon />,
    nextChat: <ArrowDownIcon />,
    goBack: <ArrowLeftIcon />,
    goForward: <ArrowRightIcon />,
    toggleSidebar: <SidebarSimpleIcon />,
    toggleFilePanel: <FolderTreeIcon />,
    searchFiles: <MagnifyingGlassIcon />,
    toggleRightSidebar: <SidebarSimpleIcon className="-scale-x-100" />,
    closeTab: <XIcon />,
    newTerminal: <TerminalWindowIcon />,
    openDiff: <GitDiffIcon />,
    openHistory: <ClockCounterClockwiseIcon />,
    openSettings: <GearIcon />,
    openUsage: <ChartBarIcon />
};

/** Never listed: the palette itself, and what only works while typing a prompt. */
const UNLISTED = new Set<ActionId>(["commandPalette"]);

const chatTitle = (chat: Chat) => chat.title ?? folderName(chat.cwd);

const copy = (text: string) => void navigator.clipboard.writeText(text).catch(() => {});

function chatItem(chat: Chat, session: Session | undefined): PaletteItem {
    return {
        id: `chat:${chat.id}`,
        label: chatTitle(chat),
        detail: chat.worktree
            ? `${folderName(chat.cwd)} · ${chat.worktree.branch}`
            : folderName(chat.cwd),
        icon: <HarnessIcon harness={chat.config.harness} />,
        chat: {
            status: statusOf(chat, session),
            at: chat.lastMessageAt ?? chat.createdAt,
            archived: chat.archived
        },
        run: () => chats.select(chat.id)
    };
}

function fileItem(cwd: string, path: string, showFolder: boolean): PaletteItem {
    const slash = path.lastIndexOf("/");
    const dir = slash < 0 ? "" : path.slice(0, slash);
    return {
        id: `file:${cwd}\0${path}`,
        label: path.slice(slash + 1),
        detail: showFolder ? [folderName(cwd), dir].filter(Boolean).join("/") : dir,
        icon: <FileIcon name={path} />,
        run: () => openFileTab(cwd, path)
    };
}

/** Commands about the open chat, before the app-wide ones. */
function chatActions(chat: Chat | undefined, session: Session | undefined): PaletteItem[] {
    if (!chat) return [];
    const items: PaletteItem[] = [];
    if (session?.status === "working" || session?.status === "awaitingInput") {
        items.push({
            id: "chat-stop",
            label: "Stop the turn",
            icon: <StopIcon />,
            run: () => void chats.interrupt(chat.id)
        });
    }
    const pinned = chat.pinnedAt != null;
    items.push(
        {
            id: "chat-pin",
            label: pinned ? "Unpin chat" : "Pin chat",
            icon: pinned ? <PushPinSlashIcon /> : <PushPinIcon />,
            run: () => void chats.setPinned(chat.id, !pinned)
        },
        {
            id: "chat-archive",
            label: chat.archived ? "Unarchive chat" : "Archive chat",
            icon: chat.archived ? <TrayArrowUpIcon /> : <ArchiveIcon />,
            run: () => void chats.setArchived(chat.id, !chat.archived)
        },
        {
            id: "chat-copy-path",
            label: "Copy folder path",
            detail: folderName(workDir(chat)),
            icon: <ClipboardTextIcon />,
            run: () => copy(workDir(chat))
        },
        {
            id: "chat-reveal",
            label: "Reveal folder",
            detail: folderName(workDir(chat)),
            icon: <FolderOpenIcon />,
            run: () => void revealItemInDir(workDir(chat)).catch(() => {})
        }
    );
    return items;
}

function appActions(): PaletteItem[] {
    return ACTIONS.filter(
        (a) => a.scope === "global" && !UNLISTED.has(a.id) && canRunAction(a.id)
    ).map((a) => ({
        id: `action:${a.id}`,
        label: a.label,
        detail: a.description,
        icon: ACTION_ICONS[a.id],
        shortcut: a.id,
        run: () => void runAction(a.id)
    }));
}

function settingsItems(): PaletteItem[] {
    return SETTINGS_PAGES.map((page) => ({
        id: `settings:${page.id}`,
        label: `Settings: ${page.label}`,
        icon: <page.icon />,
        run: () => settings.open(page.id)
    }));
}

/** Search words for an action beyond its label. */
const actionKeywords = new Map(ACTIONS.map((a) => [`action:${a.id}`, a.keywords]));

/**
 * The palette's sections for `raw` (what the field holds). Empty: recent
 * chats, recent files, then actions. Else each source ranked, or only one
 * after a prefix (`>`, `#`, `@`).
 */
export function usePaletteSections(raw: string): PaletteSection[] {
    const { scope, query } = parseQuery(useDeferredValue(raw));
    const allChats = useChatsStore((s) => s.chats);
    const sessions = useChatsStore((s) => s.sessions);
    const activeChatId = useChatsStore((s) => s.activeChatId);
    const recentChats = usePaletteStore((s) => s.chats);
    const recentFiles = usePaletteStore((s) => s.files);
    const folder = useActiveFolder();
    const wantFiles = scope === "all" || scope === "files";
    const workspace = useWorkspaceFiles(folder, wantFiles && query !== "");

    return useMemo(() => {
        const active = allChats.find((c) => c.id === activeChatId);
        const sections: PaletteSection[] = [];
        const push = (id: SectionId, title: string, items: PaletteItem[]) => {
            if (items.length) sections.push({ id, title, items });
        };
        const limit = (n: number) => (scope === "all" ? n : SCOPED);
        const actions = [...chatActions(active, active && sessions[active.id]), ...appActions()];

        if (query === "") {
            if (scope === "all" || scope === "chats") {
                // Chats opened lately, then the most recently active ones.
                const byId = new Map(allChats.map((c) => [c.id, c]));
                const seen = new Set<string>(activeChatId ? [activeChatId] : []);
                const picked: Chat[] = [];
                const n = limit(RECENT_CHATS);
                const take = (chat: Chat | undefined) => {
                    if (!chat || seen.has(chat.id) || picked.length >= n) return;
                    if (chat.archived && scope === "all") return;
                    seen.add(chat.id);
                    picked.push(chat);
                };
                recentChats.forEach((id) => take(byId.get(id)));
                allChats.forEach(take);
                push("chats", "Recent chats", picked.map((c) => chatItem(c, sessions[c.id])));
            }
            if (scope === "all" || scope === "files") {
                const files = recentFiles.slice(0, limit(RECENT_FILES));
                const many = new Set(files.map((f) => f.cwd)).size > 1;
                push(
                    "files",
                    "Recent files",
                    files.map((f) => fileItem(f.cwd, f.path, many || f.cwd !== folder))
                );
            }
            if (scope === "all" || scope === "actions") {
                push("actions", "Actions", actions);
                if (scope === "actions") push("settings", "Settings", settingsItems());
            }
            return sections;
        }

        if (scope === "all" || scope === "chats") {
            const ranked = rankBy(
                allChats,
                (chat) => {
                    const s = scoreWords(query, [
                        { text: chatTitle(chat), bonus: 10, fuzzy: true },
                        { text: folderName(chat.cwd), bonus: 0, fuzzy: true },
                        { text: chat.worktree?.branch ?? "", bonus: 0 }
                    ]);
                    return s === null ? null : s - (chat.archived ? 5 : 0);
                },
                limit(MIXED.chats)
            );
            push("chats", "Chats", ranked.map((c) => chatItem(c, sessions[c.id])));
        }

        if (wantFiles) {
            // The open folder's files, and recent ones from other folders.
            type Candidate = { cwd: string; path: string; recent: boolean };
            const recentHere = new Set(
                recentFiles.filter((f) => f.cwd === folder).map((f) => f.path)
            );
            const candidates: Candidate[] = [
                ...(folder && workspace
                    ? workspace
                          .filter((e) => !e.dir)
                          .map((e) => ({ cwd: folder, path: e.path, recent: recentHere.has(e.path) }))
                    : []),
                ...recentFiles
                    .filter((f) => f.cwd !== folder || !workspace)
                    .map((f) => ({ cwd: f.cwd, path: f.path, recent: true }))
            ];
            const ranked = rankBy(
                candidates,
                (c) => {
                    const s = scoreEntry(query, { path: c.path, dir: false });
                    return s === null ? null : s + (c.recent ? 15 : 0);
                },
                limit(MIXED.files)
            );
            push(
                "files",
                "Files",
                ranked.map((c) => fileItem(c.cwd, c.path, c.cwd !== folder))
            );
        }

        if (scope === "all" || scope === "actions") {
            const score = (item: PaletteItem) =>
                scoreWords(query, [
                    { text: item.label, bonus: 10, fuzzy: true },
                    { text: item.detail ?? "", bonus: 0 },
                    { text: actionKeywords.get(item.id) ?? "", bonus: 0 }
                ]);
            push("actions", "Actions", rankBy(actions, score, limit(MIXED.actions)));
            push("settings", "Settings", rankBy(settingsItems(), score, limit(MIXED.settings)));
        }
        return sections;
    }, [
        scope,
        query,
        allChats,
        sessions,
        activeChatId,
        recentChats,
        recentFiles,
        folder,
        workspace,
        wantFiles
    ]);
}
