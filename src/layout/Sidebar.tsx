import { ChatList, SidebarSearch, StatusFilter } from "@/features/sidebar";
import { SidePanel } from "./SidePanel";

/** The chats panel: New chat and search, what chats are doing, then the chat list by project. */
export function Sidebar() {
    return (
        <SidePanel panel="chats" label="Chats">
            <SidebarSearch />
            <StatusFilter />
            <nav
                aria-label="Chats"
                className="hide-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 py-1"
            >
                <ChatList />
            </nav>
        </SidePanel>
    );
}
