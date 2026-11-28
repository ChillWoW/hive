import {
    BookOpenIcon,
    FileIcon,
    FilePlusIcon,
    FolderOpenIcon,
    GlobeIcon,
    ListChecksIcon,
    MagnifyingGlassIcon,
    PencilSimpleIcon,
    PlugsConnectedIcon,
    PuzzlePieceIcon,
    RobotIcon,
    StopIcon,
    TerminalIcon,
    TerminalWindowIcon,
    ToolboxIcon
} from "@phosphor-icons/react";
import type { ComponentType } from "react";
import type { MessagePart, ToolCall } from "@/proto";
import type { JsonValue } from "@/proto/serde_json/JsonValue";
import type { ToolPart } from "../fold";
import { OutcodeIcon } from "./OutcodeIcon";

export type { ToolPart };

/** Outcode's own MCP server (`McpServer::OUTCODE`): its tools get the app's mark. */
const OUTCODE_SERVER = "outcode";
type ReasoningPart = Extract<MessagePart, { kind: "reasoning" }>;

/**
 * One line in a tool group: a call, a run of back-to-back file changes (two
 * or more, any files), or a thought riding along with them.
 */
export type GroupItem =
    | { kind: "call"; part: ToolPart }
    | { kind: "edits"; parts: ToolPart[] }
    | { kind: "thought"; part: ReasoningPart; live: boolean };

/** The file a call changes, when it's a write or an edit. */
function changedPath(call: ToolCall): string | undefined {
    return call.kind === "writeFile" || call.kind === "editFile" ? call.path : undefined;
}

/** A path as a comparison key: forward slashes, case folded on a Windows drive. */
function pathKey(path: string): string {
    const p = path.replace(/\\/g, "/");
    return /^[a-z]:/i.test(p) ? p.toLowerCase() : p;
}

/** The distinct files a run of changes touched, in first-touched order. */
export function editedFiles(parts: ToolPart[]): string[] {
    const files = new Map<string, string>();
    for (const part of parts) {
        const path = changedPath(part.call);
        if (path && !files.has(pathKey(path))) files.set(pathKey(path), path);
    }
    return [...files.values()];
}

/**
 * Adds a call to a group, folding it into the line before when both change
 * files: consecutive only, so rows never move while a turn streams. A failed
 * change stands on its own and ends the run.
 */
export function pushCall(items: GroupItem[], part: ToolPart) {
    const change = !part.isError && changedPath(part.call) !== undefined;
    const prev = items.at(-1);
    if (change && prev?.kind === "edits") {
        prev.parts.push(part);
        return;
    }
    if (change && prev?.kind === "call" && !prev.part.isError && changedPath(prev.part.call) !== undefined) {
        items[items.length - 1] = { kind: "edits", parts: [prev.part, part] };
        return;
    }
    items.push({ kind: "call", part });
}

/**
 * A call still waiting for its result while the turn runs, or a subagent
 * still working (in the background, it outlives its turn).
 */
export function isRunning(part: ToolPart, streaming: boolean) {
    return (streaming && !part.resolved) || part.subagent === "running";
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
    return call.kind === "readFile" ? call.path : changedPath(call);
}

/** A rail icon: a phosphor icon or one of ours, sized and coloured by `className`. */
export type ToolIcon = ComponentType<{ className?: string }>;

function stringField(input: JsonValue | undefined, key: string): string | undefined {
    if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
    const value = input[key];
    return typeof value === "string" ? value : undefined;
}

/**
 * An MCP server's name as people know it: Claude's connector and plugin
 * prefixes (`claude_ai_Gmail`, `plugin_context7_context7`) peeled,
 * separators as spaces, all-lowercase words capitalized.
 */
function serverLabel(server: string): string {
    const peeled = server.replace(/^claude_ai_/, "").replace(/^plugin_[^_]+_/, "");
    return singleLine(peeled.replace(/[_-]+/g, " "))
        .split(" ")
        .map((word) => (word === word.toLowerCase() ? word.charAt(0).toUpperCase() + word.slice(1) : word))
        .join(" ");
}

/** A tool's name as words: `get_file_contents` → "get file contents", `browserClick` → "browser click". */
function toolWords(tool: string): string {
    return singleLine(tool.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ")).toLowerCase();
}

/** `text` with its first letter capitalized. */
function sentenceCase(text: string): string {
    return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The input's most telling value: a string under a well-known key, else its first short string. */
function mainArg(input: JsonValue | undefined): string {
    if (!input || typeof input !== "object" || Array.isArray(input)) return "";
    for (const key of ["query", "q", "url", "uri", "path", "file_path", "command", "name", "title", "id"]) {
        const value = stringField(input, key);
        if (value?.trim()) return value;
    }
    for (const value of Object.values(input)) {
        if (typeof value === "string" && value.trim() && value.length <= 200) return value;
    }
    return "";
}

/** Claude's own tools for MCP resources, by what they do. */
const MCP_RESOURCE_TOOLS: Record<string, string> = {
    ListMcpResourcesTool: "List resources",
    ReadMcpResourceTool: "Read resource",
    ReadMcpResourceDirTool: "List resources"
};

function mcpResourceTool(call: ToolCall): string | undefined {
    return call.kind === "unknown" ? MCP_RESOURCE_TOOLS[call.name] : undefined;
}

/** "Gmail · uri" for a resource call: the server it asked, then what it asked for. */
function mcpResourceDetail(call: ToolCall): string {
    const input = call.kind === "unknown" ? call.input : undefined;
    const server = stringField(input, "server");
    const target = stringField(input, "uri") ?? stringField(input, "path") ?? "";
    return [server && serverLabel(server), target].filter(Boolean).join(" · ");
}

/**
 * Claude's deferred-tool loader: `select:A,B` loads those tools, anything
 * else searches. `query` is as sent (untrimmed); undefined without one.
 */
export function toolSearch(call: ToolCall): { select: string[] | undefined; query?: string } | undefined {
    if (call.kind !== "unknown" || call.name !== "ToolSearch") return undefined;
    const query = stringField(call.input, "query");
    const raw = query?.trim() ?? "";
    const select = raw.startsWith("select:")
        ? raw
              .slice("select:".length)
              .split(",")
              .map((name) => name.trim())
              .filter(Boolean)
        : undefined;
    return { select, query };
}

/** Claude's skill loader: the skill's name and the arguments it was handed. */
export function skillOf(call: ToolCall): { name: string; args: string } | undefined {
    if (call.kind !== "unknown" || call.name !== "Skill") return undefined;
    return {
        name: stringField(call.input, "skill")?.trim() ?? "",
        args: stringField(call.input, "args")?.trim() ?? ""
    };
}

/** Claude's background-task tools (and their older Bash-only names) by what they do. */
const TASK_TOOLS: Record<string, { label: string; icon: ToolIcon }> = {
    TaskStop: { label: "Stop task", icon: StopIcon },
    KillShell: { label: "Stop task", icon: StopIcon },
    TaskOutput: { label: "Task output", icon: TerminalIcon },
    BashOutput: { label: "Task output", icon: TerminalIcon }
};

function taskTool(call: ToolCall) {
    return call.kind === "unknown" ? TASK_TOOLS[call.name] : undefined;
}

/**
 * What a task tool acted on: the command its result names (`TaskStop`
 * answers `{ message, task_id, command }`), else the task id it was given.
 */
function taskDetail(call: ToolCall, output: string | undefined): string {
    const input = call.kind === "unknown" ? call.input : undefined;
    const id =
        stringField(input, "task_id") ?? stringField(input, "shell_id") ?? stringField(input, "bash_id") ?? "";
    if (output?.trimStart().startsWith("{")) {
        try {
            const parsed: unknown = JSON.parse(output);
            const command = (parsed as { command?: unknown } | null)?.command;
            if (typeof command === "string" && command.trim()) return command;
        } catch {
            // Not the JSON shape; the id will do.
        }
    }
    return id;
}

export function iconOf(call: ToolCall): ToolIcon {
    if (toolSearch(call)) return ToolboxIcon;
    if (skillOf(call)) return BookOpenIcon;
    if (mcpResourceTool(call)) return PlugsConnectedIcon;
    const task = taskTool(call);
    if (task) return task.icon;
    switch (call.kind) {
        case "exec":
            return TerminalWindowIcon;
        case "readFile":
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
        case "mcp":
            if (call.server !== OUTCODE_SERVER) return PlugsConnectedIcon;
            // Its browser tools act on a page, as a fetch reads one.
            return call.tool.startsWith("browser_") ? GlobeIcon : OutcodeIcon;
        case "subagent":
            return RobotIcon;
        default:
            return PuzzlePieceIcon;
    }
}

/**
 * A thought's one-line preview for its row: a `**Heading**` line — the
 * latest while it's live, so the row follows along, else the first —
 * otherwise the first sentence; Markdown flattened to plain text.
 */
export function thoughtPreview(markdown: string, live: boolean): string {
    const headings = [...markdown.matchAll(/^[ \t]*\*\*([^*\r\n]+)\*\*[ \t]*\r?$/gm)].map((m) => m[1]);
    const heading = live ? headings.at(-1) : headings[0];
    const text = singleLine(
        (heading ?? markdown)
            .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
            .replace(/^[ \t]*(?:#{1,6}|[-*+>]|\d+\.)[ \t]+/gm, "")
            .replace(/`+|\*\*|~~/g, "")
            .replace(/(^|[^\w*])[*_]([^*_\n]+)[*_](?![\w*])/g, "$1$2")
    );
    if (heading !== undefined) return text;
    const end = /[.?!:]["'”’)]?(?=\s)/.exec(text);
    return end ? text.slice(0, end.index + end[0].length) : text;
}

/** Whitespace runs folded to single spaces, for one-line slots. */
export function singleLine(text: string) {
    return text.split(/\s+/).filter(Boolean).join(" ");
}

/**
 * A call's label and one-line detail: "Run  cargo test", "Edit  lib.rs".
 * `output` is the call's result, for tools whose detail is only known then.
 */
export function chipContent(
    call: ToolCall,
    cwd?: string,
    output?: string
): { label: string; detail: string } {
    const chip = (label: string, detail: string) => ({ label, detail: singleLine(detail) });
    const search = toolSearch(call);
    if (search) {
        return search.select
            ? chip("Load tools", search.select.join(", "))
            : chip("Find tools", search.query ?? "");
    }
    const skill = skillOf(call);
    if (skill) return chip("Skill", skill.name);
    const resource = mcpResourceTool(call);
    if (resource) return chip(resource, mcpResourceDetail(call));
    const task = taskTool(call);
    if (task) return chip(task.label, taskDetail(call, output));
    switch (call.kind) {
        case "exec":
            return chip("Run", call.command);
        case "readFile":
            return chip("Read", call.path);
        case "writeFile":
            return chip("Write", call.path);
        case "editFile":
            return chip("Edit", call.path);
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
            return chip("Todo", call.items.length ? `${done}/${call.items.length} done` : "");
        }
        case "mcp":
            // The tool says what it did, as the other lines' verbs do; its server and argument follow.
            return chip(
                sentenceCase(toolWords(call.tool)),
                [serverLabel(call.server), mainArg(call.input)].filter(Boolean).join(" · ")
            );
        case "subagent":
            return chip("Agent", [call.agent, call.description].filter(Boolean).join(" · "));
        case "unknown":
            return chip(sentenceCase(toolWords(call.name)) || "Tool", mainArg(call.input));
    }
}

/** `chipContent` labels as a line says them: while running, then once done. */
const TENSES: Record<string, [running: string, done: string]> = {
    Run: ["Running", "Ran"],
    Read: ["Reading", "Read"],
    Write: ["Writing", "Wrote"],
    Edit: ["Editing", "Edited"],
    Search: ["Searching", "Searched"],
    Glob: ["Listing", "Listed"],
    Fetch: ["Fetching", "Fetched"],
    Web: ["Searching web", "Searched web"],
    Todo: ["Updating todos", "Todos"],
    "Load tools": ["Loading tools", "Loaded tools"],
    "Find tools": ["Finding tools", "Found tools"],
    Agent: ["Running agent", "Agent"]
};

/** A call's label in the tense of its line: "Running" while it runs, "Ran" after. */
export function lineLabel(label: string, running: boolean): string {
    const tenses = TENSES[label];
    return tenses ? tenses[running ? 0 : 1] : label;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

type SummarySegment = { text: string; danger?: boolean };

/** A header count: how many, and whether any of them is still going. */
type Tally = { n: number; live: boolean };

/**
 * The group header: "Thought process · Ran 3 commands · edited 2 files ·
 * 1 failed". Thoughts first, then calls by kind in a fixed order, changed
 * files counted once each (written when only ever written, else edited),
 * failures last. A kind with a call still running says so: "running 2
 * commands", "thinking". Only the leading letter is capitalized.
 */
export function summarize(items: GroupItem[], streaming: boolean): SummarySegment[] {
    const tally = () => ({ n: 0, live: false });
    const thoughts = tally();
    const commands = tally();
    const reads = tally();
    const searches = tally();
    const fetches = tally();
    const todos = tally();
    const agents = tally();
    const other = tally();
    let failed = 0;
    // Changed files by key: whether an edit touched it, and whether a change to it still runs.
    const files = new Map<string, { edited: boolean; live: boolean }>();
    const count = (t: Tally, live: boolean) => {
        t.n++;
        t.live ||= live;
    };
    const change = (part: ToolPart) => {
        const path = changedPath(part.call);
        if (!path) return;
        const key = pathKey(path);
        const file = files.get(key) ?? { edited: false, live: false };
        file.edited ||= part.call.kind === "editFile";
        file.live ||= isRunning(part, streaming);
        files.set(key, file);
    };

    for (const item of items) {
        if (item.kind === "thought") {
            count(thoughts, item.live);
            continue;
        }
        if (item.kind === "edits") {
            item.parts.forEach(change);
            continue;
        }
        const { call, isError } = item.part;
        const live = isRunning(item.part, streaming);
        if (isError) failed++;
        switch (call.kind) {
            case "exec":
                count(commands, live);
                break;
            case "writeFile":
            case "editFile":
                change(item.part);
                break;
            case "readFile":
                count(reads, live);
                break;
            case "search":
            case "glob":
            case "webSearch":
                count(searches, live);
                break;
            case "webFetch":
                count(fetches, live);
                break;
            case "todo":
                count(todos, live);
                break;
            case "subagent":
                count(agents, live);
                break;
            default:
                count(other, live);
        }
    }

    const edited = { n: 0, live: false };
    const written = { n: 0, live: false };
    for (const file of files.values()) count(file.edited ? edited : written, file.live);

    const segments: SummarySegment[] = [];
    // `[running, done]` verbs before the count.
    const add = (t: Tally, [running, done]: [string, string], noun?: [string, string]) => {
        if (!t.n) return;
        const verb = t.live ? running : done;
        segments.push({ text: noun ? `${verb} ${plural(t.n, ...noun)}` : verb });
    };
    if (thoughts.n) {
        segments.push({
            text: thoughts.live ? "thinking" : thoughts.n === 1 ? "thought process" : `thought ${thoughts.n} times`
        });
    }
    add(commands, ["running", "ran"], ["command", "commands"]);
    add(edited, ["editing", "edited"], ["file", "files"]);
    add(written, ["writing", "wrote"], ["file", "files"]);
    add(reads, ["reading", "read"], ["file", "files"]);
    // "Searching" alone while live: "searching 2 times" reads wrong.
    if (searches.live) segments.push({ text: "searching" });
    else add(searches, ["searching", "searched"], ["time", "times"]);
    add(fetches, ["fetching", "fetched"], ["page", "pages"]);
    add(todos, ["updating todos", "updated todos"]);
    add(agents, ["running", "ran"], ["agent", "agents"]);
    add(other, ["calling", "called"], ["tool", "tools"]);
    if (segments.length === 0) segments.push({ text: plural(items.length, "tool", "tools") });
    if (failed) segments.push({ text: `${failed} failed`, danger: true });

    const first = segments[0]!;
    first.text = first.text.charAt(0).toUpperCase() + first.text.slice(1);
    return segments;
}
