import { Menu } from "@/ui";
import {
    DETAILS_ITEMS,
    isDefaultDetailsItems,
    resetDetailsItems,
    setDetailsItem,
    useDetailsItems
} from "./items";

/**
 * A menu's body showing and hiding the chat details card's rows, then Reset
 * to default: the card's right-click menu, its empty state's and Settings ›
 * Chats share it.
 */
export function DetailsItemsMenuItems() {
    const shown = useDetailsItems();
    return (
        <>
            <Menu.Group>
                <Menu.GroupLabel>Show in chat details</Menu.GroupLabel>
                {DETAILS_ITEMS.map(({ id, label }) => (
                    <Menu.CheckboxItem
                        key={id}
                        checked={shown[id]}
                        // Stays open, so several can be switched in a row.
                        closeOnClick={false}
                        onCheckedChange={(checked) => setDetailsItem(id, checked)}
                    >
                        {label}
                    </Menu.CheckboxItem>
                ))}
            </Menu.Group>
            <Menu.Separator />
            <Menu.Item disabled={isDefaultDetailsItems(shown)} onClick={resetDetailsItems}>
                Reset to default
            </Menu.Item>
        </>
    );
}
