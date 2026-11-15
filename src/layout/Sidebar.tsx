import { ChatList, SidebarSearch } from "@/features/sidebar";
import { SettingsButton } from "@/features/settings";
import { SidePanel } from "./SidePanel";

/** The left column: New chat and search, the chat list by project, settings at its foot. */
export function Sidebar() {
    return (
        <SidePanel panel="left" label="Sidebar">
            <SidebarSearch />
            <nav
                aria-label="Chats"
                className="hide-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 py-1"
            >
                <ChatList />
            </nav>
            <div className="flex shrink-0 flex-col px-2 py-1.5">
                <SettingsButton />
            </div>
        </SidePanel>
    );
}
