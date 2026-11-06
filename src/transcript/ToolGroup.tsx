import { Fragment, use, useState, type ReactNode } from "react";
import { Collapsible } from "@base-ui/react/collapsible";
import {
    CaretRightIcon,
    CheckIcon,
    CircleIcon,
    CircleNotchIcon,
    PencilSimpleIcon
} from "@phosphor-icons/react";
import type { FileDiff } from "@/diff/patch";
import type { JsonValue } from "@/proto/serde_json/JsonValue";
import { cn } from "@/lib/cn";
import { baseName } from "@/lib/paths";
import { FileIcon } from "@/ui";
import { ChatCwd, LiveTasks } from "./context";
import { ShellRow } from "./ShellRow";
import { isBackgroundShell } from "./shellTask";
import { diffLines, toFileDiff, toFileView } from "./diff";
import { DiffView } from "./DiffView";
import { Markdown } from "./Markdown";
import { ThoughtIcon } from "./ThoughtIcon";
import {
    blockClassName,
    lineBodyClassName,
    lineClassName,
    panelTransition,
    targetClassName,
    verbClassName
} from "./line";
import {
    chipContent,
    editedFiles,
    iconOf,
    isRunning,
    lineLabel,
    pathOf,
    shortPath,
    skillOf,
    summarize,
    thoughtPreview,
    toolSearch,
    type GroupItem,
    type ToolIcon,
    type ToolPart
} from "./tools";

/** Output past this many lines folds into a "N more lines" row. */
const MAX_LINES = 24;

/** A group's header: what the group did, then a chevron that turns as it opens. */
export function FoldHeader({ className, children }: { className?: string; children: ReactNode }) {
    return (
        <Collapsible.Trigger
            className={cn(
                "group/header flex h-6 max-w-full items-center gap-1.5 text-left text-[13px] text-dark-250 transition-colors hover:text-dark-100",
                className
            )}
        >
            {children}
            <CaretRightIcon
                weight="bold"
                className="size-3 shrink-0 opacity-80 transition-transform duration-200 group-data-panel-open/header:rotate-90"
            />
        </Collapsible.Trigger>
    );
}

/**
 * A run of consecutive tool calls and thoughts behind one quiet summary —
 * "Thought process · Ran 3 commands · edited 2 files · 1 failed" — opening
 * onto a line per item: a small muted icon, the verb, what it acted on.
 *
 * Open while `active` (the group is the tail of a turn still running), then
 * folded; a click makes it the user's either way. The header stays muted
 * even when a call failed: agents routinely fail probes mid-work, so the
 * failed item and the summary's count carry the red, not the whole step.
 */
export function ToolGroup({
    items,
    active,
    streaming
}: {
    items: GroupItem[];
    active: boolean;
    streaming: boolean;
}) {
    const [userOpen, setUserOpen] = useState<boolean>();
    const tasks = use(LiveTasks);
    // Commands still running in the background keep the group open past its turn.
    const background = items.filter(
        (item) => item.kind === "call" && tasks.some((t) => t.toolCallId === item.part.id)
    ).length;

    return (
        <Collapsible.Root open={userOpen ?? (active || background > 0)} onOpenChange={setUserOpen}>
            <FoldHeader>
                <span className={cn("min-w-0 truncate", active && "shimmer")}>
                    {summarize(items).map((s, i) => (
                        <Fragment key={i}>
                            {i > 0 && " · "}
                            <span className={cn(s.danger && "text-danger")}>{s.text}</span>
                        </Fragment>
                    ))}
                    {background > 0 && (
                        <>
                            {" · "}
                            <span className="text-info">{background} running</span>
                        </>
                    )}
                </span>
            </FoldHeader>
            <Collapsible.Panel className={panelTransition}>
                <div className="flex flex-col pt-1">
                    {items.map((item) => (
                        <Item
                            // A run keeps its first call's key, so the row
                            // stays put (and keeps its fold) as it grows.
                            key={item.kind === "edits" ? item.parts[0]!.id : item.part.id}
                            item={item}
                            streaming={streaming}
                        />
                    ))}
                </div>
            </Collapsible.Panel>
        </Collapsible.Root>
    );
}

/** A line's icon: muted, red when it failed, blue while it runs past its turn. */
export function LineIcon({
    icon: Icon,
    failed,
    running = false
}: {
    icon: ToolIcon;
    failed: boolean;
    /** Still running past its turn (a background shell). */
    running?: boolean;
}) {
    return (
        <Icon
            className={cn(
                "size-3.5 shrink-0 transition-colors",
                failed ? "text-danger" : running ? "text-info" : "text-dark-300 group-hover/item:text-dark-200"
            )}
        />
    );
}

/** A file on a line: its icon and name. */
function FileName({ path, failed }: { path: string; failed: boolean }) {
    return (
        <span
            className={cn(
                "flex min-w-0 items-center gap-1.5 transition-colors",
                failed ? "text-danger" : "text-dark-200 group-hover/item:text-dark-100"
            )}
        >
            <FileIcon name={path} className="size-[13px] shrink-0" />
            <span className="min-w-0 truncate">{baseName(path)}</span>
        </span>
    );
}

/** `+12 −3`, in the line's smaller type. */
function Counts({ added, removed }: { added: number; removed: number }) {
    if (!added && !removed) return null;
    return (
        <span className="shrink-0 text-xs tabular-nums">
            {added > 0 && <span className="text-success">+{added}</span>}
            {added > 0 && removed > 0 && " "}
            {removed > 0 && <span className="text-danger">−{removed}</span>}
        </span>
    );
}

/** Each file a run of changes touched, with its lines added and removed, in first-touched order. */
function fileCounts(parts: ToolPart[]) {
    return editedFiles(parts).map((path) => {
        let added = 0;
        let removed = 0;
        for (const part of parts) {
            if (pathOf(part.call) !== path) continue;
            const change = changeOf(part);
            added += change?.additions ?? 0;
            removed += change?.deletions ?? 0;
        }
        return { path, added, removed };
    });
}

function Item({ item, streaming }: { item: GroupItem; streaming: boolean }) {
    const cwd = use(ChatCwd);
    const tasks = use(LiveTasks);
    // Everything starts folded (a live thought's preview is on its line);
    // a click opens it.
    const [open, setOpen] = useState(false);
    const call = item.kind === "call" ? item.part.call : undefined;

    // A command left running in the background: a live row of its own.
    if (item.kind === "call" && call?.kind === "exec") {
        const part = item.part;
        const task = tasks.find((t) => t.toolCallId === part.id);
        if (isBackgroundShell(part, task)) {
            return (
                <ShellRow
                    part={part}
                    task={task}
                    icon={(tone) => (
                        <LineIcon
                            icon={iconOf(part.call)}
                            failed={tone === "failed" || part.isError}
                            running={tone === "running"}
                        />
                    )}
                    body={<CallBody part={part} />}
                />
            );
        }
    }
    const failed = item.kind === "call" && item.part.isError;
    const running =
        (item.kind === "call" && isRunning(item.part, streaming)) ||
        (item.kind === "edits" && item.parts.some((p) => isRunning(p, streaming)));
    const live = running || (item.kind === "thought" && item.live);

    let label: string;
    let target: ReactNode = null;
    if (item.kind === "thought") {
        label = item.live ? "Thinking" : "Thought";
        const preview = thoughtPreview(item.part.text, item.live);
        if (preview) target = <span className={targetClassName}>{preview}</span>;
    } else if (item.kind === "edits") {
        label = running ? "Editing" : "Edited";
        target = (
            <span className="flex min-w-0 items-center gap-3 overflow-hidden">
                {fileCounts(item.parts).map(({ path, added, removed }) => (
                    <span key={path} className="flex min-w-0 items-center gap-1.5">
                        <FileName path={path} failed={false} />
                        <Counts added={added} removed={removed} />
                    </span>
                ))}
            </span>
        );
    } else {
        const content = chipContent(item.part.call, cwd, item.part.output);
        label = lineLabel(content.label, running);
        const path = pathOf(item.part.call);
        if (path) {
            const change = changeOf(item.part);
            target = (
                <>
                    <FileName path={path} failed={failed} />
                    {!failed && <Counts added={change?.additions ?? 0} removed={change?.deletions ?? 0} />}
                </>
            );
        } else if (content.detail) {
            target = <span className={targetClassName}>{content.detail}</span>;
        }
    }

    const body =
        item.kind === "thought" ? (
            item.part.text.trim() && (
                <div className={blockClassName}>
                    <Markdown className="markdown-muted markdown-small" streaming={item.live}>
                        {item.part.text}
                    </Markdown>
                </div>
            )
        ) : item.kind === "edits" ? (
            // Every change on its own line.
            <div className="flex flex-col pb-1">
                {item.parts.map((part) => (
                    <Item key={part.id} item={{ kind: "call", part }} streaming={streaming} />
                ))}
            </div>
        ) : (
            <CallBody part={item.part} />
        );

    const icon = call ? iconOf(call) : item.kind === "edits" ? PencilSimpleIcon : ThoughtIcon;
    const line = (
        <>
            <LineIcon icon={icon} failed={failed} />
            <span className={cn(verbClassName, live && "shimmer")}>{label}</span>
            {target}
            {failed && <span className="shrink-0 text-xs text-danger">failed</span>}
        </>
    );

    if (!body) return <div className={lineClassName}>{line}</div>;
    return (
        <Collapsible.Root open={open} onOpenChange={setOpen}>
            <Collapsible.Trigger className={cn(lineClassName, "cursor-pointer")}>{line}</Collapsible.Trigger>
            <Collapsible.Panel className={panelTransition}>
                <div className={lineBodyClassName}>{body}</div>
            </Collapsible.Panel>
        </Collapsible.Root>
    );
}

/** Each part's change, worked out once: parts are immutable snapshots, replaced when they change. */
const changes = new WeakMap<ToolPart, FileDiff | null>();

/**
 * Before → after of a file change: the result's diff, else what the call
 * asked for. Line numbers only for a new file's content, the whole file.
 */
function changeOf(part: ToolPart): FileDiff | undefined {
    let change = changes.get(part);
    if (change === undefined) {
        change = readChange(part) ?? null;
        changes.set(part, change);
    }
    return change ?? undefined;
}

function readChange(part: ToolPart): FileDiff | undefined {
    if (part.diff) {
        const { path, oldText, newText } = part.diff;
        return toFileDiff(path, diffLines(oldText ?? "", newText), oldText === undefined);
    }
    const call = part.call;
    if (call.kind === "editFile" && (call.oldString !== undefined || call.newString !== undefined)) {
        return toFileDiff(call.path, diffLines(call.oldString ?? "", call.newString ?? ""), false);
    }
    if (call.kind === "writeFile" && call.content !== undefined) {
        return toFileDiff(call.path, diffLines("", call.content), true);
    }
    return undefined;
}

/** Each read's file view, worked out once, as `changes`. */
const views = new WeakMap<ToolPart, FileDiff | null>();

/** What a finished read came back with, as the file's lines; undefined for anything else. */
function viewOf(part: ToolPart): FileDiff | undefined {
    const call = part.call;
    if (call.kind !== "readFile" || part.isError || !part.output) return undefined;
    let view = views.get(part);
    if (view === undefined) {
        view = toFileView(call.path, part.output) ?? null;
        views.set(part, view);
    }
    return view ?? undefined;
}

/** Verbatim mono lines, the tail past `MAX_LINES` counted rather than shown. */
function Lines({ text, className }: { text: string; className?: string }) {
    const lines = text.replace(/\n+$/, "").split("\n");
    const hidden = Math.max(0, lines.length - MAX_LINES);
    return (
        <div className={className}>
            {lines.slice(0, MAX_LINES).map((line, i) => (
                <div key={i} className="min-h-[18px] whitespace-pre">
                    {line}
                </div>
            ))}
            {hidden > 0 && (
                <div className="pt-0.5 font-sans text-dark-250">
                    {hidden.toLocaleString()} more {hidden === 1 ? "line" : "lines"}
                </div>
            )}
        </div>
    );
}

/** Input as pretty JSON; nothing for none or `{}`. */
function json(value: JsonValue | undefined) {
    if (value === undefined || value === null) return "";
    if (typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0) return "";
    return JSON.stringify(value, null, 2);
}

/**
 * What exactly was asked, when the line cut it short: the whole command,
 * pattern, URL or input. Nothing for file calls, whose line names the file.
 */
function invocationOf(part: ToolPart, cwd: string | undefined): string {
    const call = part.call;
    switch (call.kind) {
        case "exec":
            return `$ ${call.command}`;
        case "search":
            return call.path ? `${call.pattern}\nin ${shortPath(call.path, cwd)}` : call.pattern;
        case "glob":
            return call.pattern;
        case "webFetch":
            return call.prompt ? `${call.url}\n${call.prompt}` : call.url;
        case "webSearch":
            return call.query;
        case "unknown": {
            const skill = skillOf(call);
            if (skill) return skill.args ? `${skill.name}\n${skill.args}` : skill.name;
            return toolSearch(call)?.query ?? json(call.input);
        }
        case "mcp":
            return json(call.input);
        case "readFile":
        case "writeFile":
        case "editFile":
        case "applyPatch":
        case "todo":
        case "subagent":
            return "";
    }
}

/** An open call: a diff or a task list, else one block with the invocation over the output. */
function CallBody({ part }: { part: ToolPart }): ReactNode {
    const cwd = use(ChatCwd);
    const call = part.call;
    if (call.kind === "todo") {
        return (
            <ul className={cn(blockClassName, "flex flex-col gap-1 text-xs")}>
                {call.items.map((item, i) => (
                    <li key={i} className="flex items-start gap-2">
                        {item.status === "completed" ? (
                            <CheckIcon className="mt-0.5 size-3 shrink-0 text-success" weight="bold" />
                        ) : item.status === "inProgress" ? (
                            <CircleNotchIcon className="mt-0.5 size-3 shrink-0 text-dark-100" weight="bold" />
                        ) : (
                            <CircleIcon className="mt-0.5 size-3 shrink-0 text-dark-400" />
                        )}
                        <span
                            className={cn(
                                item.status === "completed"
                                    ? "text-dark-250 line-through"
                                    : item.status === "inProgress"
                                      ? "text-dark-50"
                                      : "text-dark-200"
                            )}
                        >
                            {item.text}
                        </span>
                    </li>
                ))}
            </ul>
        );
    }
    const change = changeOf(part);
    if (change && change.lineCount > 0 && !part.isError) return <DiffView file={change} className="mt-0.5 mb-2" />;
    const read = viewOf(part);
    if (read) return <DiffView file={read} className="mt-0.5 mb-2" />;

    const invocation = invocationOf(part, cwd);
    const output = part.output?.trim() ? part.output : "";
    if (!invocation && !output) return null;
    return (
        <div className={cn(blockClassName, "flex flex-col gap-1.5 font-mono text-xs leading-[18px]")}>
            {invocation && <Lines text={invocation} className="text-dark-100" />}
            {output && <Lines text={output} className={part.isError ? "text-danger/80" : "text-dark-250"} />}
        </div>
    );
}
