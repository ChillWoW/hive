import { Fragment, use, useMemo, useState, type ReactNode } from "react";
import { Collapsible } from "@base-ui/react/collapsible";
import {
    CaretDownIcon,
    CaretRightIcon,
    CheckIcon,
    CircleIcon,
    CircleNotchIcon
} from "@phosphor-icons/react";
import type { JsonValue } from "@/proto/serde_json/JsonValue";
import { cn } from "@/lib/cn";
import { FileIcon } from "@/ui";
import { ChatCwd } from "./context";
import { diffLines, toFileDiff } from "./diff";
import { DiffView } from "./DiffView";
import { Markdown } from "./Markdown";
import {
    chipContent,
    fileName,
    iconOf,
    isRunning,
    pathOf,
    shortPath,
    summarize,
    THOUGHT_ICON,
    type GroupItem,
    type ToolIcon,
    type ToolPart
} from "./tools";

/** Output past this many lines folds into a "N more lines" row. */
const MAX_LINES = 24;

const panelTransition =
    "h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-200 ease-out data-ending-style:h-0 data-starting-style:h-0";

/**
 * A run of consecutive tool calls and thoughts behind one quiet summary —
 * "Thought process · Ran 3 commands · edited 2 files · 1 failed" — opening
 * onto a tree rail with one line per item.
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
    const open = userOpen ?? active;
    const segments = summarize(items);

    return (
        <Collapsible.Root open={open} onOpenChange={setUserOpen}>
            <Collapsible.Trigger className="group/header flex h-[26px] max-w-full items-center gap-1.5 pr-1 text-left text-xs text-dark-200 transition-colors hover:text-dark-50">
                <span className="relative h-[18px] w-[22px] shrink-0">
                    <CaretDownIcon
                        weight="bold"
                        className="absolute top-0.5 left-[5.5px] size-3.5 -rotate-90 transition-transform duration-200 group-data-panel-open/header:rotate-0"
                    />
                </span>
                <span className={cn("min-w-0 truncate", active && "shimmer")}>
                    {segments.map((s, i) => (
                        <Fragment key={i}>
                            {i > 0 && " · "}
                            <span className={cn(s.danger && "text-danger")}>{s.text}</span>
                        </Fragment>
                    ))}
                </span>
            </Collapsible.Trigger>
            <Collapsible.Panel className={panelTransition}>
                <div className="flex flex-col pt-0.5">
                    {items.map((item, i) => (
                        <Item
                            key={item.part.id}
                            item={item}
                            last={i === items.length - 1}
                            streaming={streaming}
                        />
                    ))}
                </div>
            </Collapsible.Panel>
        </Collapsible.Root>
    );
}

/**
 * The tree: a trunk down the gutter, a rounded elbow out to each item's
 * icon, and the trunk carrying on past an open item's body to the next.
 * Opaque strokes, so the joints don't double up the way alpha would.
 */
function Rail({ icon: RailIcon, failed, last }: { icon: ToolIcon; failed: boolean; last: boolean }) {
    return (
        <div aria-hidden className="relative w-12 shrink-0 self-stretch">
            <span className="absolute top-0 left-3 h-2.5 w-px bg-dark-600" />
            {!last && <span className="absolute top-2.5 bottom-0 left-3 w-px bg-dark-600" />}
            <span className="absolute top-2.5 left-3 h-1.5 w-4 rounded-bl-[6px] border-b border-l border-dark-600" />
            <RailIcon
                className={cn("absolute top-2 left-8 size-4", failed ? "text-danger" : "text-dark-200")}
            />
        </div>
    );
}

/** A file the call touched, as a chip: its name only; the path is in the tooltip. */
function FileBadge({ path, failed }: { path: string; failed: boolean }) {
    const cwd = use(ChatCwd);
    return (
        <span
            title={shortPath(path, cwd)}
            className={cn(
                "flex h-[22px] min-w-0 items-center gap-1.5 rounded-[5px] bg-white/[0.06] pr-1.5 pl-px",
                failed ? "text-danger" : "text-dark-100 group-hover/item:text-dark-50"
            )}
        >
            <span className="flex size-5 shrink-0 items-center justify-center rounded-[4px] bg-white/[0.05]">
                <FileIcon name={path} className={cn("size-3.5", failed && "opacity-60")} />
            </span>
            <span className="min-w-0 truncate">{fileName(path)}</span>
        </span>
    );
}

function Item({ item, last, streaming }: { item: GroupItem; last: boolean; streaming: boolean }) {
    const cwd = use(ChatCwd);
    const thought = item.kind === "thought";
    const call = item.kind === "call" ? item.part.call : undefined;
    const failed = item.kind === "call" && item.part.isError;
    const running = item.kind === "call" && isRunning(item.part, streaming);
    const { label, detail } = call
        ? chipContent(call, cwd)
        : { label: "Thought process", detail: "" };
    const path = call && pathOf(call);
    const body =
        item.kind === "thought" ? (
            item.part.text.trim() && (
                <div className="pt-0.5 pb-2">
                    <Markdown className="markdown-muted markdown-small" streaming={item.live}>
                        {item.part.text}
                    </Markdown>
                </div>
            )
        ) : (
            <CallBody part={item.part} />
        );

    // A live thought is open, so the thinking can be watched; everything
    // else waits for a click.
    const [userOpen, setUserOpen] = useState<boolean>();
    const open = userOpen ?? (thought && item.live);

    const header = (
        <>
            <span
                className={cn(
                    "shrink-0",
                    failed ? "text-danger" : "text-dark-200 group-hover/item:text-dark-50",
                    (running || (item.kind === "thought" && item.live)) && "shimmer"
                )}
            >
                {label}
            </span>
            {failed && <span className="shrink-0 text-danger">Failed</span>}
            {path ? (
                <FileBadge path={path} failed={failed} />
            ) : (
                detail && (
                    <span
                        className={cn(
                            "min-w-0 truncate",
                            failed ? "text-danger/80" : "text-dark-250 group-hover/item:text-dark-100"
                        )}
                    >
                        {detail}
                    </span>
                )
            )}
            {call && <Trailing part={item.part as ToolPart} />}
            {body && (
                <span className="ml-auto flex size-[18px] shrink-0 items-center justify-center text-dark-250 opacity-0 transition-opacity group-hover/item:opacity-100 group-data-panel-open/item:opacity-100">
                    <CaretRightIcon
                        weight="bold"
                        className="size-3 transition-transform duration-200 group-data-panel-open/item:rotate-90"
                    />
                </span>
            )}
        </>
    );
    const rowClassName = "group/item flex h-8 w-full min-w-0 items-center gap-2 text-left text-xs";

    return (
        <div className="flex min-w-0">
            <Rail icon={call ? iconOf(call) : THOUGHT_ICON} failed={failed} last={last} />
            <div className="ml-2 min-w-0 flex-1">
                {body ? (
                    <Collapsible.Root open={open} onOpenChange={setUserOpen}>
                        <Collapsible.Trigger className={rowClassName}>{header}</Collapsible.Trigger>
                        <Collapsible.Panel className={panelTransition}>{body}</Collapsible.Panel>
                    </Collapsible.Root>
                ) : (
                    <div className={rowClassName}>{header}</div>
                )}
            </div>
        </div>
    );
}

/** After the detail: +/- counts for a file change. */
function Trailing({ part }: { part: ToolPart }) {
    const change = useChange(part);
    if (!change) return null;
    const { additions: added, deletions: removed } = change;
    if (!added && !removed) return null;
    return (
        <span className="shrink-0 tabular-nums">
            {added > 0 && <span className="text-success">+{added}</span>}
            {added > 0 && removed > 0 && " "}
            {removed > 0 && <span className="text-danger">−{removed}</span>}
        </span>
    );
}

/**
 * Before → after of a file change: the result's diff, else what the call
 * asked for. Line numbers only for a new file's content, the whole file.
 */
function useChange(part: ToolPart) {
    return useMemo(() => {
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
    }, [part]);
}

/** Verbatim mono lines, the tail past `MAX_LINES` counted rather than shown. */
function Lines({ text, className }: { text: string; className?: string }) {
    const lines = text.replace(/\n+$/, "").split("\n");
    const hidden = Math.max(0, lines.length - MAX_LINES);
    return (
        <div className={cn("overflow-x-auto py-1.5 font-mono text-xs leading-[18px]", className)}>
            {lines.slice(0, MAX_LINES).map((line, i) => (
                <div key={i} className="min-h-[18px] whitespace-pre">
                    {line}
                </div>
            ))}
            {hidden > 0 && (
                <div className="font-sans text-dark-250">
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

/** What exactly was asked: the whole command, pattern, URL or input the header cut to one line. */
function invocationOf(part: ToolPart, cwd: string | undefined): string {
    const call = part.call;
    switch (call.kind) {
        case "exec":
            return call.command;
        case "readFile":
        case "writeFile":
        case "editFile":
            return shortPath(call.path, cwd);
        case "applyPatch":
            return call.path ? shortPath(call.path, cwd) : "";
        case "search":
            return call.path ? `${call.pattern}\nin ${shortPath(call.path, cwd)}` : call.pattern;
        case "glob":
            return call.pattern;
        case "webFetch":
            return call.prompt ? `${call.url}\n${call.prompt}` : call.url;
        case "webSearch":
            return call.query;
        case "unknown":
            if (call.name === "ToolSearch") {
                const input = call.input;
                if (input && typeof input === "object" && !Array.isArray(input) && typeof input.query === "string") {
                    return input.query;
                }
            }
            return json(call.input);
        case "mcp":
            return json(call.input);
        case "todo":
        case "subagent":
            return "";
    }
}

/** An open call: the invocation, then what came back — a diff, a task list or the output. */
function CallBody({ part }: { part: ToolPart }): ReactNode {
    const cwd = use(ChatCwd);
    const change = useChange(part);
    const invocation = invocationOf(part, cwd);
    const call = part.call;

    let result: ReactNode = null;
    if (call.kind === "todo") {
        result = (
            <ul className="flex flex-col gap-1 py-1.5 text-xs">
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
    } else if (change && change.lineCount > 0 && !part.isError) {
        result = <DiffView file={change} className="my-1.5" />;
    } else if (part.output?.trim()) {
        result = (
            <Lines text={part.output} className={part.isError ? "text-danger/80" : "text-dark-250"} />
        );
    }

    if (!invocation && !result) return null;
    return (
        <div className="pb-1.5">
            {invocation && <Lines text={invocation} className="text-dark-200" />}
            {result}
        </div>
    );
}
