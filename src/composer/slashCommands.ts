import type { SlashCommand } from "@/proto";
import { fuzzyScore } from "@/lib/fuzzy";

/** Commands Hive runs itself, never sent to the agent (as in t3code). */
export type AppCommandId = "model" | "plan" | "default" | "usage-limits";

export type AppCommand = { id: AppCommandId; description: string };

/**
 * One row of the `/` and `$` menus: a Hive command, the agent's command, or
 * one of its skills (which complete to `$name`, in either menu).
 */
export type SlashItem =
    | { type: "app"; name: AppCommandId; description: string }
    | { type: "command"; name: string; description: string; inputHint?: string }
    | { type: "skill"; name: string; description: string; inputHint?: string };

export const ITEM_PREFIX: Record<SlashItem["type"], string> = {
    app: "/",
    command: "/",
    skill: "$"
};

/** The Hive commands on offer: plan mode's only while the harness has it. */
export function appCommands({ plan, planOn }: { plan: boolean; planOn: boolean }): AppCommand[] {
    return [
        { id: "model", description: "Switch the model for this chat" },
        ...(plan
            ? [
                  planOn
                      ? { id: "default" as const, description: "Leave plan mode" }
                      : { id: "plan" as const, description: "Switch this chat into plan mode" }
              ]
            : []),
        { id: "usage-limits", description: "Show the plan's usage limits" }
    ];
}

/**
 * What the `/` menu offers: Hive's commands, then the agent's (only at the
 * start of the prompt, where the CLI expands them; one named like a Hive
 * command is Hive's; `feedback` only in a started chat, `compact` only
 * there when it would be all that's sent), then its skills.
 */
export function slashItems({
    commands,
    app,
    atStart,
    started,
    alone
}: {
    commands: SlashCommand[];
    app: AppCommand[];
    atStart: boolean;
    /** A started chat, not the new-chat view. */
    started: boolean;
    /** The command would be all that's sent. */
    alone: boolean;
}): SlashItem[] {
    const ours = new Set<string>(app.map((c) => c.id));
    const items: SlashItem[] = app.map((c) => ({
        type: "app",
        name: c.id,
        description: c.description
    }));
    if (atStart) {
        for (const c of commands) {
            if (c.kind !== "command" || ours.has(c.name)) continue;
            if (NEEDS_HISTORY.has(c.name) && !started) continue;
            if (c.name === "compact" && !alone) continue;
            items.push({ type: "command", ...pick(c) });
        }
    }
    return [...items, ...skillItems(commands)];
}

export function skillItems(commands: SlashCommand[]): SlashItem[] {
    return commands.filter((c) => c.kind === "skill").map((c) => ({ type: "skill", ...pick(c) }));
}

function pick(c: SlashCommand) {
    return { name: c.name, description: c.description, inputHint: c.inputHint };
}

/** Commands about the conversation so far: none in a chat not yet started. */
const NEEDS_HISTORY = new Set(["compact", "feedback"]);

const BOUNDARY = "-_/:.";

/**
 * Lower is better, null for no match: the name exactly, as a prefix, from a
 * word boundary, anywhere, then fuzzily; else the description the same way
 * (never fuzzily, which matches nearly anything in prose).
 */
function scoreText(value: string, query: string, base: number, fuzzy: boolean): number | null {
    if (value === query) return base;
    if (value.startsWith(query)) return base + 2;
    const at = value.indexOf(query);
    if (at > 0) {
        for (let i = at; i !== -1; i = value.indexOf(query, i + 1)) {
            if (BOUNDARY.includes(value[i - 1]!) || value[i - 1] === " ") return base + 4;
        }
        return base + 6;
    }
    if (!fuzzy) return null;
    const score = fuzzyScore(query, value);
    // fuzzyScore is higher-better; past every exact kind, best first.
    return score === null ? null : base + 100 - Math.min(score, 99);
}

function scoreItem(item: SlashItem, query: string): number | null {
    const name = scoreText(item.name.toLowerCase(), query, 0, true);
    const description = scoreText(item.description.toLowerCase(), query, 20, false);
    if (name === null) return description;
    if (description === null) return name;
    return Math.min(name, description);
}

const TYPE_ORDER: Record<SlashItem["type"], number> = { app: 0, command: 1, skill: 2 };

/** `items` matching `query`, best first; all of them, in order, for none. */
export function searchSlashItems(items: SlashItem[], query: string): SlashItem[] {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    const ranked: { item: SlashItem; score: number }[] = [];
    for (const item of items) {
        const score = scoreItem(item, q);
        if (score !== null) ranked.push({ item, score });
    }
    return ranked
        .sort(
            (a, b) =>
                a.score - b.score ||
                TYPE_ORDER[a.item.type] - TYPE_ORDER[b.item.type] ||
                a.item.name.localeCompare(b.item.name)
        )
        .map(({ item }) => item);
}

/** The Hive command a whole prompt is, if it's one of `available`. */
export function standaloneAppCommand(
    prompt: string,
    available: AppCommandId[]
): AppCommandId | null {
    const match = /^\/(\S+)$/.exec(prompt.trim());
    const name = match?.[1]?.toLowerCase();
    return available.find((id) => id === name) ?? null;
}
