import { create } from "zustand";
import { useChatsStore } from "./store";

/** A place the main pane showed: a chat (null: the new-chat view) and its subagent thread. */
type Place = { chatId: string | null; subagent: string[] };

type HistoryState = {
    places: Place[];
    /** The shown place in `places`. */
    at: number;
};

/** The most places kept; the oldest go first. */
const LIMIT = 100;

const samePlace = (a: Place, b: Place) =>
    a.chatId === b.chatId &&
    a.subagent.length === b.subagent.length &&
    a.subagent.every((id, i) => id === b.subagent[i]);

const current = (): Place => {
    const { activeChatId, subagent } = useChatsStore.getState();
    return { chatId: activeChatId, subagent };
};

/** Back/forward through the places the main pane showed, like a browser's history. */
const useHistoryStore = create<HistoryState>()(() => ({ places: [current()], at: 0 }));

// Set while `go` moves, so the move isn't recorded as a new place.
let moving = false;

useChatsStore.subscribe((s, before) => {
    if (moving) return;
    if (s.activeChatId === before.activeChatId && s.subagent === before.subagent) return;
    const place: Place = { chatId: s.activeChatId, subagent: s.subagent };
    const { places, at } = useHistoryStore.getState();
    if (samePlace(places[at], place)) return;
    const kept = [...places.slice(0, at + 1), place].slice(-LIMIT);
    useHistoryStore.setState({ places: kept, at: kept.length - 1 });
});

/** What the history moves against: the shown place and the chats that still exist. */
type World = { shown: Place; loaded: boolean; chats: readonly { id: string }[] };

const world = (): World => {
    const { loaded, chats } = useChatsStore.getState();
    return { shown: current(), loaded, chats };
};

/** The nearest place `step` (±1) away that can be shown and isn't the shown one, if any. */
function target({ places, at }: HistoryState, { shown, loaded, chats }: World, step: 1 | -1) {
    for (let i = at + step; i >= 0 && i < places.length; i += step) {
        const place = places[i];
        // A deleted chat is skipped.
        const exists = place.chatId === null || !loaded || chats.some((c) => c.id === place.chatId);
        if (exists && !samePlace(place, shown)) return i;
    }
    return null;
}

function go(step: 1 | -1): boolean {
    const state = useHistoryStore.getState();
    const index = target(state, world(), step);
    if (index === null) return false;
    const place = state.places[index];
    moving = true;
    try {
        const chats = useChatsStore.getState();
        chats.select(place.chatId);
        chats.openSubagentPath(place.subagent);
    } finally {
        moving = false;
    }
    useHistoryStore.setState({ at: index });
    return true;
}

export const history = {
    /** Shows the previous place; false when there's none. */
    back: () => go(-1),
    /** Shows the next place; false when there's none. */
    forward: () => go(1)
};

/** Whether `history.back` / `history.forward` would move now. */
export function useCanGo(step: 1 | -1): boolean {
    const places = useHistoryStore((s) => s.places);
    const at = useHistoryStore((s) => s.at);
    const loaded = useChatsStore((s) => s.loaded);
    const chats = useChatsStore((s) => s.chats);
    const chatId = useChatsStore((s) => s.activeChatId);
    const subagent = useChatsStore((s) => s.subagent);
    return target({ places, at }, { shown: { chatId, subagent }, loaded, chats }, step) !== null;
}
