import { DetailsCardIcon } from "@/ui";
import { useChatsStore } from "@/chats";
import { useChatDetailsStore } from "@/chat/details/store";
import { useShortcut } from "@/keybindings";
import { BarButton } from "./BarButton";

/** In the top bar's right corner: shows or hides the chat details card in the thread. */
export function ChatDetailsButton() {
    const hasChat = useChatsStore((s) => s.activeChatId !== null && s.subagent.length === 0);
    const open = useChatDetailsStore((s) => s.open);
    const toggle = useChatDetailsStore((s) => s.toggle);
    useShortcut("chatDetails", () => {
        if (!hasChat) return false;
        toggle();
    });
    // Hidden, not disabled, while there's no chat to show details of.
    if (!hasChat) return null;
    return (
        <BarButton label="Chat details" shortcut="chatDetails" onClick={toggle} pressed={open}>
            <DetailsCardIcon weight={open ? "fill" : "regular"} className="size-4" />
        </BarButton>
    );
}
