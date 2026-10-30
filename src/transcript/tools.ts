import {
    BookOpenIcon,
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
    ToolboxIcon
} from "@phosphor-icons/react";
import type { ComponentType } from "react";
import type { MessagePart, ToolCall } from "@/proto";
import type { JsonValue } from "@/proto/serde_json/JsonValue";
import type { PageRef } from "@/htmlpage";
import { HiveMark } from "@/ui";

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

/** A rail icon: a phosphor icon or one of ours, sized and coloured by `className`. */
export type ToolIcon = ComponentType<{ className?: string }>;

/** The server name Hive's own MCP tools come from (`McpServer::HIVE`). */
export const HIVE_SERVER = "hive";

/** How one of Hive's own tools shows: its label (the tool name otherwise) and detail. */
type HiveTool = { label?: string; detail?: (input: JsonValue | undefined) => string };

/**
 * Hive's MCP tools (`src-tauri/src/mcp.rs`) by name. Every one gets Hive's
 * mark and its name; an entry here can give it a label and a detail line.
 */
const HIVE_TOOLS: Record<string, HiveTool> = {
    request_secret: {
        label: "Asking for a secret",
        detail: (input) => stringField(input, "label") ?? ""
    },
    preview_html: {
        label: "Check page",
        detail: (input) => /<title[^>]*>([^<]*)</i.exec(stringField(input, "html") ?? "")?.[1] ?? ""
    },
    render_html: {
        label: "Show page",
        detail: (input) => stringField(input, "title") ?? ""
    }
};

function stringField(input: JsonValue | undefined, key: string): string | undefined {
    if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
    const value = input[key];
    return typeof value === "string" ? value : undefined;
}

/**
 * The page a finished `render_html` call showed (`src-tauri/src/html.rs`):
 * the saved copy its result names, else the HTML it was sent.
 */
export function pageOf(part: ToolPart): PageRef | undefined {
    const call = part.call;
    if (call.kind !== "mcp" || call.server !== HIVE_SERVER || call.tool !== "render_html") return undefined;
    if (!part.resolved || part.isError) return undefined;
    const page = resultPage(part.output);
    const html = stringField(call.input, "html");
    const file = typeof page?.file === "string" ? page.file : undefined;
    if (!file && html === undefined) return undefined;
    const height = page?.height ?? (call.input as { height?: unknown } | undefined)?.height;
    return {
        title: (typeof page?.title === "string" ? page.title : stringField(call.input, "title")) ?? "Page",
        file,
        html,
        height: typeof height === "number" ? height : undefined
    };
}

/** `page` from the tool's JSON result, wherever a CLI put the JSON in its output. */
function resultPage(output: string | undefined): Record<string, unknown> | undefined {
    if (!output) return undefined;
    const start = output.indexOf("{");
    const end = output.lastIndexOf("}");
    if (start === -1 || end < start) return undefined;
    try {
        const parsed: unknown = JSON.parse(output.slice(start, end + 1));
        const page = (parsed as { page?: unknown } | null)?.page;
        return page && typeof page === "object" ? (page as Record<string, unknown>) : undefined;
    } catch {
        return undefined;
    }
}

function isHiveTool(call: ToolCall): boolean {
    return call.kind === "mcp" && call.server === HIVE_SERVER;
}

/** Claude's deferred-tool loader: `select:A,B` loads those tools, anything else searches. */
function toolSearch(call: ToolCall): { select: string[] | undefined; query: string } | undefined {
    if (call.kind !== "unknown" || call.name !== "ToolSearch") return undefined;
    const input = call.input;
    const raw =
        input && typeof input === "object" && !Array.isArray(input) && typeof input.query === "string"
            ? input.query.trim()
            : "";
    const select = raw.startsWith("select:")
        ? raw
              .slice("select:".length)
              .split(",")
              .map((name) => name.trim())
              .filter(Boolean)
        : undefined;
    return { select, query: raw };
}

/** Claude's skill loader: the skill's name and the arguments it was handed. */
export function skillOf(call: ToolCall): { name: string; args: string } | undefined {
    if (call.kind !== "unknown" || call.name !== "Skill") return undefined;
    const input = call.input;
    if (!input || typeof input !== "object" || Array.isArray(input)) return { name: "", args: "" };
    return {
        name: typeof input.skill === "string" ? input.skill.trim() : "",
        args: typeof input.args === "string" ? input.args.trim() : ""
    };
}

export function iconOf(call: ToolCall): ToolIcon {
    if (isHiveTool(call)) return HiveMark;
    if (toolSearch(call)) return ToolboxIcon;
    if (skillOf(call)) return BookOpenIcon;
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
    if (call.kind === "mcp" && isHiveTool(call)) {
        const tool = HIVE_TOOLS[call.tool];
        return chip(tool?.label ?? call.tool, tool?.detail?.(call.input) ?? "");
    }
    const search = toolSearch(call);
    if (search) {
        return search.select
            ? chip("Load tools", search.select.join(", "))
            : chip("Find tools", search.query);
    }
    const skill = skillOf(call);
    if (skill) return chip("Skill", skill.name);
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
