import { ChatList, SidebarSearch } from "@/features/sidebar";
import { SidePanel } from "./SidePanel";

/** The chats panel: New chat and search, then the chat list by project. */
export function Sidebar() {
    return (
        <SidePanel panel="chats" label="Chats">
            <SidebarSearch />
            <nav
                aria-label="Chats"
                className="hide-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 py-1"
            >
                <ChatList />
            </nav>
        </SidePanel>
    );
}
