import { SettingsButton } from "@/features/settings";
import { SIDEBAR_WIDTH, useLayoutStore } from "./store";

/**
 * The left column. It closes by sliding its width to 0; the content keeps its
 * own width meanwhile, so it's uncovered rather than reflowed. The top bar
 * overlays its first 36px.
 */
export function Sidebar() {
    const open = useLayoutStore((s) => s.sidebarOpen);

    return (
        <aside
            aria-label="Sidebar"
            inert={!open}
            style={{ width: open ? SIDEBAR_WIDTH : 0 }}
            className="h-full shrink-0 overflow-hidden transition-[width] duration-200 ease-out"
        >
            <div
                style={{ width: SIDEBAR_WIDTH }}
                className="flex h-full flex-col border-r border-border bg-surface pt-9"
            >
                <div className="min-h-0 flex-1" />
                <div className="flex shrink-0 flex-col px-2 py-1.5">
                    <SettingsButton />
                </div>
            </div>
        </aside>
    );
}
