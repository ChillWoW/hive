import { useEffect, useState } from "react";
import type { CommandKind, SlashCommand } from "@/proto";

/** `/` and the command name being typed, before any argument. */
const TYPING_COMMAND = /^\/(\S*)$/;
/** What a skill's name is made of. */
const NAME_CHAR = /[\p{L}\p{N}_:.-]/u;
/** What may come right before a `$` that names a skill. */
const BOUNDARY = /[\s([{]/;

/** The `/command` or `$skill` being typed: where it sits, and what's typed of it. */
type Token = { kind: CommandKind; start: number; end: number; query: string };

/**
 * A command is typed as the whole field (the CLI only runs one at the start);
 * a skill anywhere, as a `$` word around the caret. `$5` or `a$b` aren't.
 */
function tokenAt(draft: string, caret: number): Token | null {
    const command = TYPING_COMMAND.exec(draft);
    if (command) {
        return { kind: "command", start: 0, end: draft.length, query: command[1] };
    }
    const at = Math.min(caret, draft.length);
    let start = at;
    while (start > 0 && NAME_CHAR.test(draft[start - 1])) start--;
    if (draft[start - 1] !== "$") return null;
    const dollar = start - 1;
    if (dollar > 0 && !BOUNDARY.test(draft[dollar - 1])) return null;
    let end = at;
    while (end < draft.length && NAME_CHAR.test(draft[end])) end++;
    const query = draft.slice(start, at);
    if (/^\p{N}/u.test(query)) return null;
    return { kind: "skill", start: dollar, end, query };
}

/** Commands by prefix; skills by prefix first, then anywhere in the name. */
function matching(commands: SlashCommand[], token: Token): SlashCommand[] {
    const query = token.query.toLowerCase();
    const ofKind = commands.filter((c) => c.kind === token.kind);
    const prefixed = ofKind.filter((c) => c.name.toLowerCase().startsWith(query));
    if (token.kind === "command") return prefixed;
    const inside = ofKind.filter(
        (c) => !prefixed.includes(c) && c.name.toLowerCase().includes(query)
    );
    return [...prefixed, ...inside];
}

export const COMMAND_PREFIX: Record<CommandKind, string> = { command: "/", skill: "$" };

export type SlashMenuState = {
    open: boolean;
    kind: CommandKind;
    matches: SlashCommand[];
    index: number;
    setIndex: (index: number) => void;
    pick: (command: SlashCommand) => void;
    /** Handles the menu's keys; true when it took the event. */
    onKeyDown: (event: React.KeyboardEvent) => boolean;
};

/**
 * Completion for `/command` and `$skill`, as in zeron: `/` while the field
 * holds only `/` and a partial name lists the commands, `$` before a partial
 * name anywhere lists the skills (skills stay out of the `/` menu). Arrows
 * move, Tab or Enter completes to `/name ` or `$name `, Escape closes it
 * until the text changes.
 */
export function useSlashMenu({
    draft,
    caret,
    commands,
    enabled,
    complete
}: {
    draft: string;
    /** The caret's offset in `draft`. */
    caret: number;
    commands: SlashCommand[];
    enabled: boolean;
    /** Sets the field's text, with the caret at `caret`. */
    complete: (text: string, caret: number) => void;
}): SlashMenuState {
    const [index, setIndex] = useState(0);
    const [dismissed, setDismissed] = useState<string | null>(null);

    const token = tokenAt(draft, caret);
    const matches = token ? matching(commands, token) : [];
    const open = enabled && matches.length > 0 && dismissed !== draft;
    const typed = token?.query.toLowerCase();

    // A new filter starts from the top.
    useEffect(() => setIndex(0), [typed, token?.kind]);

    const pick = (command: SlashCommand) => {
        if (!token) return;
        const name = `${COMMAND_PREFIX[token.kind]}${command.name}`;
        const after = draft.slice(token.end);
        const gap = after.startsWith(" ") ? "" : " ";
        const before = draft.slice(0, token.start) + name + gap;
        complete(before + after, before.length + (gap ? 0 : 1));
    };

    const onKeyDown = (event: React.KeyboardEvent) => {
        if (!open) return false;
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
                const command = matches[Math.min(index, matches.length - 1)];
                if (!command) return false;
                // A name typed out in full sends on Enter like any prompt.
                if (event.key === "Enter" && command.name.toLowerCase() === typed) {
                    return false;
                }
                pick(command);
                return true;
            }
            case "Escape":
                setDismissed(draft);
                return true;
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
