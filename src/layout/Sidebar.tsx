import { SIDEBAR_WIDTH, useLayoutStore } from "@/stores/useLayoutStore";

export function Sidebar() {
    const open = useLayoutStore((state) => state.sidebarOpen);

    return (
        <aside
            inert={!open}
            style={{ width: open ? SIDEBAR_WIDTH : 0 }}
            className="h-full shrink-0 overflow-hidden transition-[width]"
        >
            <div
                style={{ width: SIDEBAR_WIDTH }}
                className="flex h-full flex-col border-r border-dark-600 bg-dark-850 pt-9"
            >
                <div className="min-h-0 flex-1 overflow-y-auto px-2 py-1"></div>
                <div className="flex h-11 shrink-0 items-center px-2"></div>
            </div>
        </aside>
    );
}
