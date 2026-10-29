import { SettingsButton } from "@/settings";
import { ChatList } from "@/sidebar";
import { SIDEBAR_WIDTH, usePanelLayout } from "@/stores/useLayoutStore";
import { UpdateButton } from "@/updater";

export function Sidebar() {
    const open = usePanelLayout().visible.sidebar;

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
                <nav
                    aria-label="Chats"
                    className="hide-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 py-1"
                >
                    <ChatList />
                </nav>
                <div className="flex min-h-11 shrink-0 flex-col justify-center gap-1 px-2 py-1.5">
                    <UpdateButton />
                    <SettingsButton />
                </div>
            </div>
        </aside>
    );
}
