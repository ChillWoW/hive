import {
    BrainIcon,
    FileIcon,
    FilePlusIcon,
    FolderOpenIcon,
    GlobeIcon,
    ListChecksIcon,
    MagnifyingGlassIcon,
    PencilSimpleIcon,
    PuzzlePieceIcon,
    TerminalWindowIcon,
    type Icon
} from "@phosphor-icons/react";
import type { MessagePart, ToolCall } from "@/proto";

export type ToolPart = Extract<MessagePart, { kind: "tool" }>;
export type ReasoningPart = Extract<MessagePart, { kind: "reasoning" }>;

/** One line in a tool group: a call, or a thought riding along with them. */
export type GroupItem =
    | { kind: "call"; part: ToolPart }
    | { kind: "thought"; part: ReasoningPart; live: boolean };

/** A call still waiting for its result while the turn runs. */
export function isRunning(part: ToolPart, streaming: boolean) {
    return streaming && !part.resolved;
}

/** The last segment of a path, either slash. */
export function fileName(path: string): string {
    return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/** `path` relative to `cwd` when it's inside it. */
export function shortPath(path: string, cwd: string | undefined): string {
    if (!cwd) return path;
    const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
    const p = norm(path);
    const base = norm(cwd);
    const insensitive = /^[a-z]:/i.test(base);
    const starts = insensitive
        ? p.toLowerCase().startsWith(`${base.toLowerCase()}/`)
        : p.startsWith(`${base}/`);
    return starts ? p.slice(base.length + 1) : path;
}

/** The one file a call touched, shown as a file badge instead of text. */
export function pathOf(call: ToolCall): string | undefined {
    switch (call.kind) {
        case "readFile":
        case "writeFile":
        case "editFile":
            return call.path;
        case "applyPatch":
            return call.path;
        default:
            return undefined;
    }
}

export function iconOf(call: ToolCall): Icon {
    switch (call.kind) {
        case "exec":
            return TerminalWindowIcon;
        case "readFile":
        case "applyPatch":
            return FileIcon;
        case "writeFile":
            return FilePlusIcon;
        case "editFile":
            return PencilSimpleIcon;
        case "search":
            return MagnifyingGlassIcon;
        case "glob":
            return FolderOpenIcon;
        case "webFetch":
        case "webSearch":
            return GlobeIcon;
        case "todo":
            return ListChecksIcon;
        default:
            return PuzzlePieceIcon;
    }
}

export const THOUGHT_ICON = BrainIcon;

/** Whitespace runs folded to single spaces, for one-line slots. */
function singleLine(text: string) {
    return text.split(/\s+/).filter(Boolean).join(" ");
}

/** A call's label and one-line detail: "Run  cargo test", "Edit  lib.rs". */
export function chipContent(
    call: ToolCall,
    cwd?: string
): { label: string; detail: string } {
    const chip = (label: string, detail: string) => ({ label, detail: singleLine(detail) });
    switch (call.kind) {
        case "exec":
            return chip("Run", call.command);
        case "readFile":
            return chip("Read", call.path);
        case "writeFile":
            return chip("Write", call.path);
        case "editFile":
            return chip("Edit", call.path);
        case "applyPatch":
            return chip("Patch", call.path ?? "workspace");
        case "search":
            return chip(
                "Search",
                call.path ? `${call.pattern} in ${shortPath(call.path, cwd)}` : call.pattern
            );
        case "glob":
            return chip("Glob", call.pattern);
        case "webFetch":
            return chip("Fetch", call.url);
        case "webSearch":
            return chip("Web", call.query);
        case "todo": {
            const done = call.items.filter((i) => i.status === "completed").length;
            return chip("Todo", `${done}/${call.items.length} done`);
        }
        case "mcp":
            return chip("MCP", `${call.server} · ${call.tool}`);
        case "subagent":
            return chip("Agent", call.description);
        case "unknown":
            return chip("Tool", call.name);
    }
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export type SummarySegment = { text: string; danger?: boolean };

/**
 * The group header: "Thought process · Ran 3 commands · edited 2 files ·
 * 1 failed". Thoughts first, then calls by kind in a fixed order, edits
 * counting distinct files, failures last. Only the leading letter is
 * capitalized.
 */
export function summarize(items: GroupItem[]): SummarySegment[] {
    let thoughts = 0;
    let commands = 0;
    let reads = 0;
    let searches = 0;
    let fetches = 0;
    let todos = 0;
    let other = 0;
    let failed = 0;
    const edited = new Set<string>();
    for (const item of items) {
        if (item.kind === "thought") {
            thoughts++;
            continue;
        }
        const { call, isError } = item.part;
        if (isError) failed++;
        switch (call.kind) {
            case "exec":
                commands++;
                break;
            case "writeFile":
            case "editFile":
                edited.add(call.path);
                break;
            case "applyPatch":
                edited.add(call.path ?? "patch");
                break;
            case "readFile":
                reads++;
                break;
            case "search":
            case "glob":
            case "webSearch":
                searches++;
                break;
            case "webFetch":
                fetches++;
                break;
            case "todo":
                todos++;
                break;
            default:
                other++;
        }
    }

    const segments: SummarySegment[] = [];
    const add = (text: string) => segments.push({ text });
    if (thoughts === 1) add("thought process");
    else if (thoughts > 1) add(`thought ${thoughts} times`);
    if (commands) add(`ran ${plural(commands, "command", "commands")}`);
    if (edited.size) add(`edited ${plural(edited.size, "file", "files")}`);
    if (reads) add(`read ${plural(reads, "file", "files")}`);
    if (searches) add(`searched ${plural(searches, "time", "times")}`);
    if (fetches) add(`fetched ${plural(fetches, "page", "pages")}`);
    if (todos) add("updated todos");
    if (other) add(`called ${plural(other, "tool", "tools")}`);
    if (segments.length === 0) add(plural(items.length, "tool", "tools"));
    if (failed) segments.push({ text: `${failed} failed`, danger: true });

    const first = segments[0]!;
    first.text = first.text.charAt(0).toUpperCase() + first.text.slice(1);
    return segments;
}
