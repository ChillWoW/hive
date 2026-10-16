import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { isTauri } from "@/lib/platform";

export type WindowState = {
    maximized: boolean;
    fullscreen: boolean;
    focused: boolean;
};

/**
 * The window's own state, for the parts of the frame the frontend draws.
 *
 * Read by more than the window buttons: on macOS the system draws its traffic
 * lights over the top bar, and `fullscreen` is what says whether the space held
 * open for them is still needed. Outside Tauri it stays at its defaults, which
 * are what a browser tab looks like anyway.
 */
export function useWindowState(): WindowState {
    const [state, setState] = useState<WindowState>({
        maximized: false,
        fullscreen: false,
        focused: true
    });

    useEffect(() => {
        if (!isTauri) return;

        const appWindow = getCurrentWindow();
        const unlisteners: UnlistenFn[] = [];
        let disposed = false;

        const track = (promise: Promise<UnlistenFn>) => {
            void promise.then((fn) => {
                if (disposed) fn();
                else unlisteners.push(fn);
            });
        };

        const syncSize = () => {
            void Promise.all([
                appWindow.isMaximized(),
                appWindow.isFullscreen()
            ]).then(([maximized, fullscreen]) => {
                if (!disposed)
                    setState((s) => ({ ...s, maximized, fullscreen }));
            });
        };

        syncSize();
        track(appWindow.onResized(syncSize));
        track(
            appWindow.onFocusChanged(({ payload: focused }) => {
                if (!disposed) setState((s) => ({ ...s, focused }));
            })
        );

        return () => {
            disposed = true;
            for (const fn of unlisteners) fn();
        };
    }, []);

    return state;
}
