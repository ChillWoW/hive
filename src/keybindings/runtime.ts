import { useEffect, useLayoutEffect, useRef } from "react";
import { useSettingsStore } from "@/settings/store";
import { ACTIONS, type ActionId } from "./actions";
import { canonical, shortcutFromEvent, stringifyShortcut } from "./shortcut";

/**
 * Returns false when it didn't apply (nothing to do here), so the key goes
 * on to the page as if unbound.
 */
export type ShortcutHandler = () => boolean | void;

/** Per action, every mounted handler; the latest one runs. */
const handlers = new Map<ActionId, ShortcutHandler[]>();

/** Marks the element whose focus `composer`-scoped actions need. */
export const COMPOSER_SCOPE = { "data-shortcut-scope": "composer" } as const;

/**
 * Runs `handler` on the action's shortcut while the calling component is
 * mounted. The handler may change every render; the latest one runs.
 */
export function useShortcut(id: ActionId, handler: ShortcutHandler) {
    const ref = useRef(handler);
    useLayoutEffect(() => {
        ref.current = handler;
    });
    useEffect(() => {
        const run: ShortcutHandler = () => ref.current();
        const list = handlers.get(id) ?? [];
        handlers.set(id, [...list, run]);
        return () => {
            handlers.set(id, (handlers.get(id) ?? []).filter((h) => h !== run));
        };
    }, [id]);
}

/**
 * Runs an action as its shortcut would (the latest mounted handler), for the
 * command palette. False when nothing handles it now.
 */
export function runAction(id: ActionId): boolean {
    const run = handlers.get(id)?.at(-1);
    return !!run && run() !== false;
}

/** Whether something handles `id` now. */
export const canRunAction = (id: ActionId) => !!handlers.get(id)?.length;

function inScope(target: EventTarget | null, scope: "global" | "composer") {
    if (scope === "global") return true;
    return target instanceof Element && !!target.closest("[data-shortcut-scope='composer']");
}

/**
 * The one keydown listener behind every shortcut. It listens on `window` in
 * the bubble phase, so a component that handles a key itself
 * (`preventDefault`) wins. With the settings window open, only its own
 * toggle runs. Mount once, at the root.
 */
export function useKeybindingsRuntime() {
    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.defaultPrevented || event.isComposing) return;
            const pressed = shortcutFromEvent(event);
            if (!pressed) return;
            const combo = stringifyShortcut(pressed);
            const { settings, isOpen } = useSettingsStore.getState();

            for (const action of ACTIONS) {
                if (canonical(settings.keyboard[action.id]) !== combo) continue;
                if (isOpen && action.id !== "openSettings") continue;
                if (!inScope(event.target, action.scope)) continue;
                const run = handlers.get(action.id)?.at(-1);
                if (!run) continue;
                // Held down, a toggle swallows the repeats without flickering.
                if ((event.repeat && !action.repeats) || run() !== false) {
                    event.preventDefault();
                    return;
                }
            }
        };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, []);
}

/**
 * Whether `event` is the shortcut of a global action something handles now,
 * so a widget that eats keys (the terminal) can let it through to the app.
 */
export function isAppShortcut(event: KeyboardEvent) {
    const pressed = shortcutFromEvent(event);
    if (!pressed) return false;
    const combo = stringifyShortcut(pressed);
    const { keyboard } = useSettingsStore.getState().settings;
    return ACTIONS.some(
        (action) =>
            action.scope === "global" &&
            canonical(keyboard[action.id]) === combo &&
            !!handlers.get(action.id)?.length
    );
}

/** An action id, or a fixed combo the app doesn't let you rebind (`Escape`, `Mod+Enter`). */
export type ShortcutRef = ActionId | (string & {});

const isActionId = (ref: string): ref is ActionId => ACTIONS.some((a) => a.id === ref);

/** What `ref` is bound to now: the action's current binding, or the fixed combo itself. */
export function useBinding(ref: ShortcutRef): string {
    return useSettingsStore((s) => (isActionId(ref) ? s.settings.keyboard[ref] : ref));
}
