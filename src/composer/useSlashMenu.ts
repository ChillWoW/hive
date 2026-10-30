import { useEffect, useState } from "react";
import type { CommandKind, SlashCommand } from "@/proto";
import {
    type AppCommand,
    type AppCommandId,
    ITEM_PREFIX,
    searchSlashItems,
    skillItems,
    slashItems,
    type SlashItem
} from "./slashCommands";

/** What a command or skill's name is made of. */
const NAME_CHAR = /[\p{L}\p{N}_:.-]/u;
/** What may come right before a `/` or `$` that starts a name. */
const BOUNDARY = /[\s([{]/;

/** The `/command` or `$skill` being typed: where it sits, and what's typed of it. */
type Token = { kind: CommandKind; start: number; end: number; query: string };

/**
 * The `/` or `$` word around the caret: at the start or after a space or
 * bracket, then name characters only, so `a/b`, `/usr/bin` and `$5` aren't.
 */
function tokenAt(draft: string, caret: number): Token | null {
    const at = Math.min(caret, draft.length);
    let start = at;
    while (start > 0 && NAME_CHAR.test(draft[start - 1]!)) start--;
    const sigil = draft[start - 1];
    if (sigil !== "/" && sigil !== "$") return null;
    const from = start - 1;
    if (from > 0 && !BOUNDARY.test(draft[from - 1]!)) return null;
    let end = at;
    while (end < draft.length && NAME_CHAR.test(draft[end]!)) end++;
    // A path going on past the name (`/usr/bin`) isn't a command.
    if (draft[end] === "/") return null;
    const query = draft.slice(start, at);
    if (sigil === "$" && /^\p{N}/u.test(query)) return null;
    return { kind: sigil === "/" ? "command" : "skill", start: from, end, query };
}

export type SlashMenuState = {
    open: boolean;
    kind: CommandKind;
    matches: SlashItem[];
    index: number;
    setIndex: (index: number) => void;
    pick: (item: SlashItem) => void;
    /** Handles the menu's keys; true when it took the event. */
    onKeyDown: (event: React.KeyboardEvent) => boolean;
};

/**
 * Completion for `/command` and `$skill`, as in t3code. `/` at a word's
 * start lists Hive's own commands (`app`), the agent's (only at the start
 * of the prompt) and its skills, ranked against name and description; `$`
 * lists the skills. Arrows move, Tab or Enter completes to `/name ` or
 * `$name ` — or, for a Hive command, takes it out of the text and runs it
 * (`onApp`). Enter on a name typed out in full sends as usual. Escape closes
 * the menu until the text changes. Nothing matching at the prompt's start
 * says so.
 */
export function useSlashMenu({
    draft,
    caret,
    commands,
    app,
    started,
    attached,
    enabled,
    complete,
    onApp
}: {
    draft: string;
    /** The caret's offset in `draft`. */
    caret: number;
    commands: SlashCommand[];
    /** Hive's own commands on offer. */
    app: AppCommand[];
    /** A started chat, not the new-chat view. */
    started: boolean;
    /** Files are attached to the draft. */
    attached: boolean;
    enabled: boolean;
    /** Sets the field's text, with the caret at `caret`. */
    complete: (text: string, caret: number) => void;
    onApp: (id: AppCommandId) => void;
}): SlashMenuState {
    const [index, setIndex] = useState(0);
    const [dismissed, setDismissed] = useState<string | null>(null);

    const token = tokenAt(draft, caret);
    const atStart = !!token && draft.slice(0, token.start).trim() === "";
    const offered = !token
        ? []
        : token.kind === "skill"
          ? skillItems(commands)
          : slashItems({
                commands,
                app,
                atStart,
                started,
                alone: !attached && draft.slice(token.end).trim() === ""
            });
    const matches = token ? searchSlashItems(offered, token.query) : [];
    // An empty list is only worth saying where a command was clearly meant.
    const empty =
        !!token &&
        matches.length === 0 &&
        (token.kind === "command" ? atStart : offered.length > 0 && token.query !== "");
    const open = enabled && (matches.length > 0 || empty) && dismissed !== draft;
    const typed = token?.query.toLowerCase();

    // A new filter starts from the top.
    useEffect(() => setIndex(0), [typed, token?.kind]);

    const pick = (item: SlashItem) => {
        if (!token) return;
        const after = draft.slice(token.end);
        if (item.type === "app") {
            const before = draft.slice(0, token.start);
            const joined = before.endsWith(" ") && after.startsWith(" ") ? after.slice(1) : after;
            complete(before + joined, before.length);
            onApp(item.name);
            return;
        }
        const name = `${ITEM_PREFIX[item.type]}${item.name}`;
        const gap = after.startsWith(" ") ? "" : " ";
        const before = draft.slice(0, token.start) + name + gap;
        complete(before + after, before.length + (gap ? 0 : 1));
    };

    const onKeyDown = (event: React.KeyboardEvent) => {
        if (!open) return false;
        if (event.key === "Escape") {
            setDismissed(draft);
            return true;
        }
        if (matches.length === 0) return false;
        switch (event.key) {
            case "ArrowDown":
                setIndex((index + 1) % matches.length);
                return true;
            case "ArrowUp":
                setIndex((index - 1 + matches.length) % matches.length);
                return true;
            case "Tab":
            case "Enter": {
                if (event.shiftKey) return false;
                const item = matches[Math.min(index, matches.length - 1)];
                if (!item) return false;
                // A name typed out in full, as it would be completed, sends
                // on Enter like any prompt.
                if (
                    event.key === "Enter" &&
                    item.type === (token?.kind === "skill" ? "skill" : "command") &&
                    item.name.toLowerCase() === typed
                ) {
                    return false;
                }
                pick(item);
                return true;
            }
            default:
                return false;
        }
    };

    return {
        open,
        kind: token?.kind ?? "command",
        matches,
        index,
        setIndex,
        pick,
        onKeyDown
    };
}
