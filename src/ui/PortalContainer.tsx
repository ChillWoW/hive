import { createContext, useContext } from "react";
import type { ReactNode } from "react";

/** The element portalled overlays mount into. Null means the browser default, `<body>`. */
const PortalContainerContext = createContext<HTMLElement | null>(null);

/** The layer over the top bar, where a modal dims the chrome without taking its drag region. */
const ChromeLayerContext = createContext<HTMLElement | null>(null);

export interface PortalContainerProviderProps {
    container: HTMLElement | null;
    /** The layer over the top bar; modals put their chrome backdrop here. */
    chrome?: HTMLElement | null;
    children?: ReactNode;
}

/** Keeps a subtree's overlays inside `container` rather than over the viewport. The root route is
 *  the only provider: it points this at the layer below the top bar, so an open modal never covers
 *  the window's drag region. */
export const PortalContainerProvider = ({
    container,
    chrome = null,
    children
}: PortalContainerProviderProps) => (
    <PortalContainerContext.Provider value={container}>
        <ChromeLayerContext.Provider value={chrome}>
            {children}
        </ChromeLayerContext.Provider>
    </PortalContainerContext.Provider>
);

PortalContainerProvider.displayName = "PortalContainerProvider";

export function usePortalContainer(): HTMLElement | null {
    return useContext(PortalContainerContext);
}

export function useChromeLayer(): HTMLElement | null {
    return useContext(ChromeLayerContext);
}
