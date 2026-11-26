import { useEffect, useState } from "react";
import type { HarnessId, SlashCommand } from "@/proto";
import { chatsApi, useSession } from "@/features/chats";

/** Probed lists by harness and folder; each is asked once per app run. */
const probed = new Map<string, Promise<SlashCommand[]>>();

function probe(harness: HarnessId, cwd: string): Promise<SlashCommand[]> {
    const key = `${harness}:${cwd}`;
    let pending = probed.get(key);
    if (!pending) {
        pending = chatsApi.commands(harness, cwd).catch((error: unknown) => {
            console.warn("[commands]", error);
            probed.delete(key);
            return [];
        });
        probed.set(key, pending);
    }
    return pending;
}

const NONE: SlashCommand[] = [];

/**
 * The commands and skills `/` offers: what the chat's agent listed last,
 * else what its harness offers in the folder (asked once, in the background).
 */
export function useCommands(chatId: string | null, harness: HarnessId, cwd: string): SlashCommand[] {
    const listed = useSession(chatId)?.commands;
    const [found, setFound] = useState<{ key: string; commands: SlashCommand[] }>();
    const need = !listed?.length && !!cwd;
    const key = `${harness}:${cwd}`;
    useEffect(() => {
        if (!need) return;
        let live = true;
        void probe(harness, cwd).then((commands) => live && setFound({ key: `${harness}:${cwd}`, commands }));
        return () => {
            live = false;
        };
    }, [harness, cwd, need]);
    if (listed?.length) return listed;
    return found?.key === key ? found.commands : NONE;
}

/** The commands matching what follows the `/`: names starting with it first, then containing it; commands before skills. */
export function matchCommands(commands: SlashCommand[], query: string, limit = 60): SlashCommand[] {
    const q = query.toLowerCase();
    const starts = commands.filter((c) => c.name.toLowerCase().startsWith(q));
    const contains = commands.filter(
        (c) => !c.name.toLowerCase().startsWith(q) && (c.name.toLowerCase().includes(q) || (q.length > 2 && c.description.toLowerCase().includes(q)))
    );
    // The CLI's own commands before skills, each group in the CLI's order.
    const commandsFirst = (list: SlashCommand[]) => [
        ...list.filter((c) => c.kind === "command"),
        ...list.filter((c) => c.kind !== "command")
    ];
    return [...commandsFirst(starts), ...commandsFirst(contains)].slice(0, limit);
}

/** What's typed after a leading `/`, while the command's name is still being typed; else undefined. */
export function slashQuery(draft: string): string | undefined {
    return /^\/([^\s]*)$/.exec(draft)?.[1];
}
