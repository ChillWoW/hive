import { useState } from "react";
import { Sidebar, TopBar } from "@/layout";
import { SettingsModal, useSettingsRuntime } from "@/settings";
import { PortalContainerProvider } from "@/ui";

export function App() {
    useSettingsRuntime();
    // Overlays mount here, below the top bar, so an open modal never covers
    // the window's drag region or its controls.
    const [overlayLayer, setOverlayLayer] = useState<HTMLDivElement | null>(
        null
    );

    return (
        <PortalContainerProvider container={overlayLayer}>
            <div className="relative flex h-full w-full bg-dark-900 text-dark-50">
                <Sidebar />
                <main className="flex min-w-0 flex-1 flex-col overflow-hidden pt-9"></main>
                <TopBar title="Quick test" />
                <div
                    ref={setOverlayLayer}
                    className="pointer-events-none absolute inset-x-0 top-9 bottom-0 z-40"
                />
            </div>
            <SettingsModal />
        </PortalContainerProvider>
    );
}
