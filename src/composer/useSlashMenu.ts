import { useEffect, useState } from "react";
import type { SlashCommand } from "@/proto";

/** `/` and the command name being typed, before any argument. */
const TYPING_COMMAND = /^\/(\S*)$/;

export type SlashMenuState = {
    open: boolean;
    matches: SlashCommand[];
    index: number;
    setIndex: (index: number) => void;
    pick: (command: SlashCommand) => void;
    /** Handles the menu's keys; true when it took the event. */
    onKeyDown: (event: React.KeyboardEvent) => boolean;
};

/**
 * Completion for `/command`: open while the field holds only `/` and a
 * partial name, listing the commands that start with it. Arrows move, Tab or
 * Enter completes to `/name `, Escape closes it until the text changes.
 */
export function useSlashMenu({
    draft,
    commands,
    enabled,
    complete
}: {
    draft: string;
    commands: SlashCommand[];
    enabled: boolean;
    complete: (text: string) => void;
}): SlashMenuState {
    const [index, setIndex] = useState(0);
    const [dismissed, setDismissed] = useState<string | null>(null);

    const typed = TYPING_COMMAND.exec(draft)?.[1]?.toLowerCase();
    const matches =
        typed === undefined
            ? []
            : commands.filter((c) => c.name.toLowerCase().startsWith(typed));
    const open = enabled && matches.length > 0 && dismissed !== draft;

    // A new filter starts from the top.
    useEffect(() => setIndex(0), [typed]);

    const pick = (command: SlashCommand) => complete(`/${command.name} `);

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

    return { open, matches, index, setIndex, pick, onKeyDown };
}
